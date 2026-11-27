import { statfs, mkdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { DuckDBStore } from '@mastra/duckdb';
import { createClient } from '@libsql/client';
import { z } from 'zod';
import { BackupObjects, day, type Artifact, type ObjectStorage } from './objects';
import { backupTraces } from './trace';

const sources = [
  'src/mastra/public/preview.db',
  'data/vectors.db',
  'data/user-files.db',
  'data/conversation-projects.db',
  'data/account-preferences.db',
  'data/creative-memory.db',
  'data/creator-gateway.db',
  'data/story-ledger.db',
  'data/subagents.db',
] as const;

export async function backupBusiness({
  root,
  directory,
  objects,
  userFiles,
  now,
  getUserFile,
}: {
  root: string;
  directory: string;
  userFiles: string;
  objects: BackupObjects;
  now: number;
  getUserFile: ObjectStorage['get'];
}) {
  const artifacts: Artifact[] = [];
  for (const [index, path] of sources.entries()) {
    const input = path === 'data/user-files.db' ? userFiles : resolve(root, path);
    const info = await stat(input).catch(error => {
      if (error.code !== 'ENOENT' || index < 3) throw error;
    });
    if (!info) continue;
    const copy = join(directory, 'sqlite-' + index);
    const db = new DatabaseSync(input, { readOnly: true });
    try {
      await backup(db, copy, { rate: 256 });
    } finally {
      db.close();
    }
    const verify = createClient({ url: 'file:' + copy });
    try {
      const result = await verify.execute('PRAGMA integrity_check');
      if (result.rows.length !== 1 || result.rows[0]?.[0] !== 'ok')
        throw new Error('SQLite snapshot failed verification');
      if (path === 'data/user-files.db') {
        const ledger = await verify.execute(
          'SELECT DISTINCT object_key, size, digest FROM user_files ORDER BY object_key',
        );
        for (const row of ledger.rows) {
          const key = z
            .string()
            .regex(/^users\/[a-f0-9]{64}\/objects\/[a-z0-9-]+$/)
            .parse(row.object_key);
          const expected = { size: Number(row.size), digest: String(row.digest) };
          const body = await getUserFile(key);
          if (
            !body ||
            body.length !== expected.size ||
            createHash('sha256').update(body).digest('hex') !== expected.digest
          ) {
            throw new Error('OSS file version is missing or differs from the file ledger');
          }
          artifacts.push(await objects.store('oss-objects/' + key, body));
        }
      }
    } finally {
      verify.close();
    }
    artifacts.push(await objects.store(path, copy));
    await rm(copy);
  }
  const date = new Date(now).toISOString().slice(0, 10);
  await objects.publish('business/' + date + '.json', { version: 1, kind: 'business', artifacts }, true);
}

export function backupConfig(env: NodeJS.ProcessEnv) {
  const prefix = env.ALTFLOW_BACKUP_PREFIX;
  if (!prefix) return;
  return {
    prefix,
    cleanup: env.ALTFLOW_BACKUP_CLEANUP === 'true',
    archiveDays: z.coerce
      .number()
      .int()
      .min(8)
      .max(3650)
      .parse(env.ALTFLOW_BACKUP_ARCHIVE_DAYS ?? 90),
    ossWarningBytes: z.coerce
      .number()
      .int()
      .positive()
      .parse(env.ALTFLOW_BACKUP_OSS_WARNING_BYTES ?? 10 * 1024 ** 3),
    diskReserveBytes: z.coerce
      .number()
      .int()
      .positive()
      .parse(env.ALTFLOW_BACKUP_DISK_RESERVE_BYTES ?? 512 * 1024 ** 2),
    diskWarningBytes: z.coerce
      .number()
      .int()
      .positive()
      .parse(env.ALTFLOW_BACKUP_DISK_WARNING_BYTES ?? 2 * 1024 ** 3),
  };
}

export function startBackups({
  config,
  db,
  root,
  userFiles,
  storage,
}: {
  config: NonNullable<ReturnType<typeof backupConfig>>;
  db: DuckDBStore['db'];
  root: string;
  userFiles: string;
  storage: ObjectStorage;
}) {
  const objects = new BackupObjects(storage, config.prefix);
  let running = false;
  let businessDay = -1;
  let collectionDay = -1;
  const database = join(root, 'data/observability.duckdb');
  async function run() {
    if (running) return;
    running = true;
    const directory = join(root, 'data/.backup-staging');
    let stage = 'snapshot';
    try {
      const now = Date.now();
      const today = Math.floor(now / day);
      const fs = await statfs(root);
      if (fs.bavail * fs.bsize < config.diskWarningBytes) console.warn('[altflow backup] Low free space for staging');
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { mode: 0o700 });
      stage = 'trace';
      const trace = await backupTraces({ db, objects, directory, database, now, ...config });
      console.info('[altflow backup] Trace', trace);
      if (trace.after > config.diskWarningBytes)
        console.warn('[altflow backup] Trace database exceeds disk warning threshold');
      if (businessDay !== today) {
        stage = 'business';
        await backupBusiness({ root, directory, objects, userFiles, now, getUserFile: key => storage.get(key) });
        businessDay = today;
      }
      if (config.cleanup && collectionDay !== today) {
        stage = 'collection';
        const bytes = await objects.collect(now, config.archiveDays);
        console.info('[altflow backup] OSS bytes after collection', bytes);
        if (bytes > config.ossWarningBytes)
          console.warn('[altflow backup] OSS backup prefix exceeds capacity threshold');
        collectionDay = today;
      }
    } catch {
      console.error('[altflow backup] Failed at ' + stage + '. The next interval retries.');
    } finally {
      try {
        await rm(directory, { recursive: true, force: true }).catch(() =>
          console.warn('[altflow backup] Could not remove staging files'),
        );
      } finally {
        running = false;
      }
    }
  }

  const timer = setInterval(() => void run(), 15 * 60_000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
