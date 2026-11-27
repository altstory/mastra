import './environment.mjs';
import { mkdir, mkdtemp, open, rename, rm, stat, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DuckDBStore } from '@mastra/duckdb';
import OSS from 'ali-oss';
import { BackupObjects, ossBackupObjects } from '../src/mastra/backup/objects.ts';
import { compactTraces, restoreHotTraces } from '../src/mastra/backup/trace.ts';

const [operation, ...args] = process.argv.slice(2);
const env = process.env;
if (operation === 'restore' && args.length === 2) {
  const [name, output] = args;
  const storage = ossBackupObjects(
    new OSS({
      accessKeyId: env.ALTFLOW_OSS_ACCESS_KEY_ID,
      accessKeySecret: env.ALTFLOW_OSS_ACCESS_KEY_SECRET,
      region: env.ALTFLOW_OSS_REGION ?? 'oss-cn-beijing',
      bucket: env.ALTFLOW_OSS_BUCKET ?? 'altflow-harness',
      endpoint: env.ALTFLOW_OSS_ENDPOINT ?? 'https://oss-cn-beijing.aliyuncs.com',
      authorizationV4: true,
      timeout: 60_000,
    }),
  );
  const objects = new BackupObjects(storage, env.ALTFLOW_BACKUP_PREFIX ?? '');
  const manifest = await objects.read(name);
  if (!manifest) throw new Error('Backup manifest not found');
  const destination = resolve(output);
  await objects.restore(manifest, destination);
  if (manifest.kind === 'trace-hot') {
    const data = join(destination, 'data');
    await mkdir(data, { mode: 0o700 });
    const trace = new DuckDBStore({ path: join(data, 'observability.duckdb') });
    try {
      await restoreHotTraces(trace, destination, manifest.artifacts);
    } finally {
      await trace.close();
    }
  }
  console.info('Recovered %d files from %s', manifest.artifacts.length, name);
} else if (operation === 'compact' && (args.length === 0 || (args.length === 1 && args[0] === '--if-needed'))) {
  const root = resolve(env.ALTFLOW_RUNTIME_ROOT ?? env.MASTRA_PREVIEW_ROOT ?? process.cwd());
  const source = join(root, 'data/observability.duckdb');
  const automatic = args[0] === '--if-needed';
  const before = await stat(source).catch(error => {
    if (!automatic || error.code !== 'ENOENT') throw error;
  });
  if (before) await compactDatabase(root, source, before, automatic);
} else {
  throw Error('Usage: pnpm backup restore <manifest> <new-output-directory> or pnpm backup compact');
}

async function compactDatabase(root, source, before, automatic) {
  const scratch = await mkdtemp(join(root, 'data/.trace-compact-'));
  try {
    const target = join(scratch, 'compacted.duckdb');
    const live = new DuckDBStore({ path: source, memoryLimit: env.ALTFLOW_TRACE_MEMORY_LIMIT ?? '1GB', threads: 2 });
    try {
      await live.db.execute('CHECKPOINT');
      if (automatic) {
        const [size] = await live.db.query('PRAGMA database_size');
        const reclaimable = Number(size.free_blocks) * Number(size.block_size);
        if (reclaimable < 256 * 1024 ** 2) return;
        const needed = Number(size.used_blocks) * Number(size.block_size) + 64 * 1024 ** 2;
        const space = await statfs(root);
        if (space.bavail * space.bsize < needed) {
          console.warn('[altflow backup] Not enough free space to compact Trace before startup');
          return;
        }
      }
      await compactTraces(live.db, target);
      const copy = new DuckDBStore({ path: target });
      try {
        const names = await live.db.query(
          "SELECT table_name FROM duckdb_tables() WHERE schema_name = 'main' AND NOT internal",
        );
        for (const { table_name: name } of names) {
          const table = '"' + name.replaceAll('"', '""') + '"';
          const fingerprint = `SELECT COUNT(*) AS n, bit_xor(hash(t)) AS checksum FROM ${table} t`;
          const [a] = await live.db.query(fingerprint);
          const [b] = await copy.db.query(fingerprint);
          if (a.n !== b.n || a.checksum !== b.checksum) throw Error('Compacted database differs from source');
        }
      } finally {
        await copy.close();
      }
    } finally {
      await live.close();
    }
    const after = await stat(target);
    if (after.blocks >= before.blocks) {
      console.info('Compaction did not reduce allocated bytes (%d)', before.blocks * 512);
    } else {
      const file = await open(target, 'r');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(target, source);
      const parent = await open(join(root, 'data'), 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      console.info('Trace disk bytes before %d and after %d', before.blocks * 512, after.blocks * 512);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
