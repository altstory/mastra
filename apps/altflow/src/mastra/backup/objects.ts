import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { zstdCompress, zstdDecompress } from 'node:zlib';
import type OSS from 'ali-oss';
import { z } from 'zod';

export const day = 86_400_000;
const manifestName = /^(?:hot\.json|business\/\d{4}-\d{2}-\d{2}\.json|archive\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\.json)$/;
const blockSize = 4 * 1024 * 1024;
const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const block = z.object({ sha256: digest, bytes: z.number().int().positive().max(blockSize) });
export const artifact = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  blocks: z.array(block),
  rows: z.number().int().nonnegative().optional(),
});
const manifestSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['business', 'trace-hot', 'trace-archive']),
  artifacts: z.array(artifact),
});

export type Artifact = z.infer<typeof artifact>;
export type Manifest = z.infer<typeof manifestSchema>;
export interface ObjectStorage {
  get(key: string): Promise<Buffer | undefined>;
  put(key: string, data: Buffer, overwrite?: boolean): Promise<void>;
  list(prefix: string): AsyncIterable<{ key: string; modified: number; bytes?: number }>;
  delete(key: string): Promise<void>;
}

function status(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
}

export function ossBackupObjects(client: OSS): ObjectStorage {
  return {
    async get(key) {
      try {
        return Buffer.from((await client.get(key)).content);
      } catch (error) {
        if (status(error) !== 404) throw error;
      }
    },
    async put(key, data, overwrite) {
      try {
        await client.put(key, data, {
          headers: {
            'x-oss-object-acl': 'private',
            'x-oss-server-side-encryption': 'AES256',
            ...(!overwrite && { 'x-oss-forbid-overwrite': 'true' }),
          },
        });
      } catch (error) {
        if (overwrite || status(error) !== 409) throw error;
      }
    },
    async *list(prefix) {
      let continuationToken: string | undefined;
      do {
        const page = await client.listV2({ prefix, 'continuation-token': continuationToken, 'max-keys': 1000 });
        for (const item of page.objects ?? [])
          yield { key: item.name, modified: Date.parse(item.lastModified), bytes: Number(item.size) };
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
        if (page.isTruncated && !continuationToken) throw new Error('Incomplete OSS backup listing');
      } while (continuationToken);
    },
    async delete(key) {
      await client.delete(key);
    },
  };
}

function sha256(data: Buffer) {
  return createHash('sha256').update(data).digest('hex');
}

function containedPath(root: string, path: string) {
  const resolved = resolve(root, path);
  if (isAbsolute(path) || !resolved.startsWith(resolve(root) + sep)) throw new Error('Invalid backup path');
  return resolved;
}

export class BackupObjects {
  constructor(
    private readonly objects: ObjectStorage,
    private readonly prefix: string,
  ) {
    if (!/^altflow-backups\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) {
      throw new Error('Set a dedicated ALTFLOW_BACKUP_PREFIX under altflow-backups/');
    }
  }

  private blockKey(hash: string) {
    return this.prefix + '/blocks/' + hash + '.zst';
  }

  async store(path: string, source: string | Buffer): Promise<Artifact> {
    const blocks: Artifact['blocks'] = [];
    let bytes = 0;
    const pieces = Buffer.isBuffer(source)
      ? (function* () {
          for (let offset = 0; offset < source.length; offset += blockSize)
            yield source.subarray(offset, offset + blockSize);
        })()
      : createReadStream(source, { highWaterMark: blockSize });
    let pending = Buffer.alloc(0);
    for await (const piece of pieces) {
      const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
      pending = pending.length ? Buffer.concat([pending, buffer]) : buffer;
      if (pending.length < blockSize) continue;
      await storeBlock(this, pending.subarray(0, blockSize));
      pending = pending.subarray(blockSize);
    }
    if (pending.length) await storeBlock(this, pending);
    return { path, bytes, blocks };

    async function storeBlock(owner: BackupObjects, data: Buffer) {
      const reference = { sha256: sha256(data), bytes: data.length };
      const key = owner.blockKey(reference.sha256);
      let remote = await owner.objects.get(key);
      if (remote === undefined) {
        await owner.objects.put(key, await compress(data));
        remote = await owner.objects.get(key);
      }
      await checkedBlock(remote, reference);
      blocks.push(reference);
      bytes += data.length;
    }
  }

  async publish(name: string, manifest: Manifest, replace = false) {
    const body = Buffer.from(JSON.stringify(manifest));
    if (body.length >= 1024 ** 3) throw new Error('Backup manifest exceeds 1 GiB');
    const key = this.prefix + '/manifests/' + name;
    if (replace && (await this.objects.get(key))?.equals(body)) return;
    await this.objects.put(key, body, replace);
    const remote = await this.objects.get(key);
    if (!remote?.equals(body)) throw new Error('OSS backup manifest failed verification');
  }

  async archive(manifest: Manifest, now: number) {
    const hash = sha256(Buffer.from(JSON.stringify(manifest)));
    const date = new Date(now).toISOString().slice(0, 10);
    await this.publish('archive/' + date + '/' + hash + '.json', manifest);
  }

  async read(name: string) {
    if (!manifestName.test(name)) {
      throw new Error('Invalid backup manifest name');
    }
    return this.getManifest(this.prefix + '/manifests/' + name);
  }

  private async getManifest(key: string) {
    const raw = await this.objects.get(key);
    return raw ? manifestSchema.parse(JSON.parse(raw.toString())) : undefined;
  }

  async restore(manifest: Manifest, output: string) {
    await mkdir(output, { mode: 0o700 });
    try {
      for (const file of manifest.artifacts) {
        const target = containedPath(output, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const temporary = target + '.partial';
        const fd = await open(temporary, 'wx', 0o600);
        let bytes = 0;
        try {
          for (const ref of file.blocks) {
            const data = await checkedBlock(await this.objects.get(this.blockKey(ref.sha256)), ref);
            await fd.writeFile(data);
            bytes += data.length;
          }
          if (bytes !== file.bytes) throw new Error('Restored file size differs from backup manifest');
        } finally {
          await fd.close();
        }
        await rename(temporary, target);
      }
    } catch (error) {
      await rm(output, { recursive: true, force: true });
      throw error;
    }
  }

  async collect(now: number, archiveDays: number) {
    const root = this.prefix + '/manifests/';
    const manifests: { key: string; modified: number; bytes?: number }[] = [];
    let retainedBytes = 0;
    for await (const item of this.objects.list(root)) {
      if (!manifestName.test(item.key.slice(root.length)) || !Number.isFinite(item.modified)) {
        throw new Error('Unexpected OSS backup manifest');
      }
      manifests.push(item);
    }
    const keepBusiness = retainedBusiness(
      manifests.map(item => item.key).filter(key => key.startsWith(root + 'business/')),
    );
    const live = new Set<string>();
    for (const item of manifests) {
      const keep =
        item.key === root + 'hot.json' ||
        keepBusiness.has(item.key) ||
        (item.key.startsWith(root + 'archive/') && item.modified >= now - archiveDays * day);
      if (!keep) {
        await this.objects.delete(item.key);
        continue;
      }
      retainedBytes += item.bytes ?? 0;
      const manifest = await this.getManifest(item.key);
      if (!manifest) throw new Error('Listed backup manifest disappeared during collection');
      for (const file of manifest.artifacts) for (const ref of file.blocks) live.add(this.blockKey(ref.sha256));
    }
    const candidates = this.prefix + '/unreferenced/';
    const marked = new Map<string, number>();
    for await (const item of this.objects.list(candidates)) marked.set(item.key, item.modified);
    const blocks = this.prefix + '/blocks/';
    for await (const item of this.objects.list(blocks)) {
      if (!/^[a-f0-9]{64}\.zst$/.test(item.key.slice(blocks.length))) continue;
      retainedBytes += item.bytes ?? 0;
      const marker = candidates + item.key.split('/').at(-1);
      if (live.has(item.key)) {
        if (marked.has(marker)) await this.objects.delete(marker);
      } else {
        const markedAt = marked.get(marker);
        if (markedAt === undefined) {
          await this.objects.put(marker, Buffer.from(String(now)));
        } else if (markedAt <= now - 7 * day) {
          await this.objects.delete(item.key);
          retainedBytes -= item.bytes ?? 0;
          await this.objects.delete(marker);
        }
      }
    }
    return retainedBytes;
  }
}

async function checkedBlock(packed: Buffer | undefined, ref: Artifact['blocks'][number]) {
  if (!packed) throw new Error('Missing OSS backup block');
  const data = await decompress(packed, { maxOutputLength: blockSize });
  if (data.length !== ref.bytes || sha256(data) !== ref.sha256) throw new Error('OSS backup block failed verification');
  return data;
}

function retainedBusiness(keys: string[]) {
  const keep = new Set<string>();
  const weeks = new Set<number>();
  const months = new Set<string>();
  for (const [index, key] of keys.sort().reverse().entries()) {
    const date = key.slice(-15, -5);
    const week = Math.floor((Date.parse(date) + 3 * day) / (7 * day));
    const month = date.slice(0, 7);
    if (index < 7 || (weeks.size < 4 && !weeks.has(week)) || (months.size < 3 && !months.has(month))) keep.add(key);
    weeks.add(week);
    months.add(month);
  }
  return keep;
}
