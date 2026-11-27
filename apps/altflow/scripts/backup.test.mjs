import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createClient } from '@libsql/client';
import { DuckDBStore } from '@mastra/duckdb';
import { BackupObjects, day } from '../src/mastra/backup/objects.ts';
import { backupBusiness } from '../src/mastra/backup/service.ts';
import { backupTraces, compactTraces, restoreHotTraces } from '../src/mastra/backup/trace.ts';

const now = Date.UTC(2026, 10, 27);
const prefix = 'altflow-backups/integration';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'altflow-backup-test-'));
  const spill = join(root, 'staging');
  await mkdir(spill);
  const remote = join(root, 'objects');
  await mkdir(remote);
  let offline = false;
  let published;
  const writes = [];
  const storage = {
    async get(key) {
      if (offline) throw Error('simulated storage outage');
      return readFile(join(remote, key)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
    async put(key, data, overwrite) {
      if (offline) throw Error('simulated storage outage');
      const file = join(remote, key);
      await mkdir(dirname(file), { recursive: true });
      try {
        await writeFile(file, data, { flag: overwrite ? 'w' : 'wx' });
        writes.push(key);
        if (published) await published(key);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    },
    async *list(folder) {
      const dir = join(remote, folder);
      for (const file of await readdir(dir, { recursive: true }).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return [];
      })) {
        const info = await stat(join(dir, file));
        if (info.isFile()) yield { key: folder + file, modified: info.mtimeMs };
      }
    },
    async delete(key) {
      await rm(join(remote, key), { force: true });
    },
  };
  const objects = new BackupObjects(storage, prefix);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    spill,
    remote,
    objects,
    storage,
    writes,
    setOffline(value) {
      offline = value;
    },
    onPut(handler) {
      published = handler;
    },
  };
}

test('failed archive keeps runs, retry preserves concurrent feedback and backs up only changed content', async t => {
  const f = await fixture(t);
  const database = join(f.root, 'trace.duckdb');
  const store = new DuckDBStore({ path: database });
  await store.observability.init();
  t.after(() => store.close());
  const old = new Date(now - 8 * day);
  await store.db.execute(
    `INSERT INTO span_events (traceId, spanId, eventType, timestamp, endedAt) VALUES
      ('done','a','start',?,NULL), ('done','a','end',?,?),
      ('running','b','start',?,NULL), ('recent','d','end',?,?)`,
    [old, old, old, old, new Date(now - day), new Date(now - day)],
  );
  await store.db.execute(
    "INSERT INTO feedback_events (feedbackId, traceId, timestamp, feedbackSource, feedbackType, value) VALUES (?, ?, ?, ?, 'rating', 'positive')",
    ['review', 'done', old, 'user'],
  );
  const run = (time = now) =>
    backupTraces({
      db: store.db,
      objects: f.objects,
      directory: f.spill,
      database,
      now: time,
      cleanup: true,
      archiveDays: 90,
    });
  f.setOffline(true);
  await assert.rejects(run(), /storage outage/);
  assert.deepEqual(await store.db.query('SELECT traceId FROM span_events ORDER BY traceId'), [
    { traceId: 'done' },
    { traceId: 'done' },
    { traceId: 'recent' },
    { traceId: 'running' },
  ]);
  f.setOffline(false);
  f.onPut(async key => {
    if (!key.includes('/archive/')) return;
    f.onPut(undefined);
    await store.db.execute("UPDATE feedback_events SET reviewStatus = 'reviewed' WHERE feedbackId = 'review'");
    await store.db.execute(
      "INSERT INTO feedback_events (feedbackId, traceId, timestamp, feedbackSource, feedbackType, value) VALUES (?, ?, ?, ?, 'rating', 'positive')",
      ['later', 'done', new Date(now), 'user'],
    );
  });
  await run();
  assert.deepEqual(await store.db.query('SELECT traceId FROM span_events ORDER BY traceId'), [
    { traceId: 'recent' },
    { traceId: 'running' },
  ]);
  assert.deepEqual(await store.db.query('SELECT feedbackId FROM feedback_events ORDER BY feedbackId'), [
    { feedbackId: 'later' },
  ]);
  const archives = [];
  for await (const { key } of f.storage.list(prefix + '/manifests/archive/')) archives.push(key);
  assert.equal(archives.length, 2);
  for (const [i, key] of archives.entries()) {
    const output = join(f.root, 'restored-' + i);
    await f.objects.restore(await f.objects.read(key.split('/manifests/')[1]), output);
  }
  const archivedFeedback = await store.db.query(
    "SELECT reviewStatus FROM read_parquet(?) WHERE feedbackId = 'review'",
    [join(f.root, 'restored-*', 'feedback_events.parquet')],
  );
  assert.deepEqual(new Set(archivedFeedback.map(row => row.reviewStatus)), new Set(['needs-review', 'reviewed']));
  const blocks = f.writes.filter(key => key.includes('/blocks/')).length;
  await run();
  assert.equal(f.writes.filter(key => key.includes('/blocks/')).length, blocks);
  const hot = await f.objects.read('hot.json');
  const hotOutput = join(f.root, 'restored-hot');
  await f.objects.restore(hot, hotOutput);
  const restored = new DuckDBStore({ path: join(hotOutput, 'observability.duckdb') });
  try {
    await restoreHotTraces(restored, hotOutput, hot.artifacts);
    assert.deepEqual(await restored.db.query('SELECT feedbackId FROM feedback_events'), [{ feedbackId: 'later' }]);
  } finally {
    await restored.close();
  }
  const compacted = join(f.root, 'compact.duckdb');
  await compactTraces(store.db, compacted);
  const copy = new DuckDBStore({ path: compacted });
  try {
    assert.deepEqual(await copy.db.query('SELECT traceId FROM span_events ORDER BY traceId'), [
      { traceId: 'recent' },
      { traceId: 'running' },
    ]);
  } finally {
    await copy.close();
  }
});

test('daily snapshots reuse unchanged blocks and restore a WAL database, a vector index, and OSS file contents', async t => {
  const f = await fixture(t);
  const previewPath = join(f.root, 'src/mastra/public/preview.db');
  const ledgerPath = join(f.root, 'data/user-files.db');
  await mkdir(dirname(previewPath), { recursive: true });
  await mkdir(dirname(ledgerPath), { recursive: true });
  const preview = new DatabaseSync(previewPath);
  const ledger = new DatabaseSync(ledgerPath);
  const vectors = createClient({ url: 'file:' + join(f.root, 'data/vectors.db') });
  t.after(() => {
    preview.close();
    ledger.close();
    vectors.close();
  });
  preview.exec("PRAGMA journal_mode=WAL; CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('first');");
  await vectors.execute('CREATE TABLE search (id INTEGER PRIMARY KEY, embedding F32_BLOB(2))');
  await vectors.execute('CREATE INDEX search_idx ON search(libsql_vector_idx(embedding))');
  await vectors.execute("INSERT INTO search(embedding) VALUES(vector32('[1,2]'))");
  const body = Buffer.from('creative content');
  const key = 'users/' + 'a'.repeat(64) + '/objects/file';
  ledger.exec('CREATE TABLE user_files(object_key, size, digest)');
  ledger
    .prepare('INSERT INTO user_files VALUES(?,?,?)')
    .run(key, body.length, createHash('sha256').update(body).digest('hex'));
  await f.storage.put(key, body);
  const run = time =>
    backupBusiness({
      root: f.root,
      directory: f.spill,
      objects: f.objects,
      userFiles: ledgerPath,
      now: time,
      getUserFile: key => f.storage.get(key),
    });
  await run(now);
  const before = f.writes.filter(key => key.includes('/blocks/')).length;
  await run(now + day);
  assert.equal(f.writes.filter(key => key.includes('/blocks/')).length, before);
  preview.exec("INSERT INTO messages VALUES ('second')");
  await run(now + 2 * day);
  assert.equal(f.writes.filter(key => key.includes('/blocks/')).length, before + 1);
  await f.storage.delete(key);
  const restored = join(f.root, 'recovered');
  await f.objects.restore(await f.objects.read('business/2026-11-29.json'), restored);
  assert.deepEqual(await readFile(join(restored, 'oss-objects', key)), body);
  const restoredDb = new DatabaseSync(join(restored, 'src/mastra/public/preview.db'), { readOnly: true });
  try {
    assert.deepEqual(
      restoredDb
        .prepare('SELECT text FROM messages')
        .all()
        .map(row => row.text),
      ['first', 'second'],
    );
  } finally {
    restoredDb.close();
  }
});

test('expired manifests release unreferenced blocks after a grace period and keep shared blocks', async t => {
  const f = await fixture(t);
  const fsTime = Date.now();
  const shared = await f.objects.store('still-needed', Buffer.from('shared data'));
  const old = await f.objects.store('expired', Buffer.from('old Trace'));
  await f.objects.publish('hot.json', { version: 1, kind: 'trace-hot', artifacts: [shared] });
  await f.objects.archive({ version: 1, kind: 'trace-archive', artifacts: [shared, old] }, fsTime);
  await f.objects.collect(fsTime + 91 * day, 90);
  const blockPath = prefix + '/blocks/' + old.blocks[0].sha256 + '.zst';
  assert.ok(await f.storage.get(blockPath));
  const { utimes } = await import('node:fs/promises');
  const marked = join(f.remote, prefix, 'unreferenced', old.blocks[0].sha256 + '.zst');
  const markedAt = new Date(fsTime + 91 * day);
  await utimes(marked, markedAt, markedAt);
  await f.objects.collect(fsTime + 99 * day, 90);
  assert.equal(await f.storage.get(blockPath), undefined);
  const fresh = join(f.root, 'after-collection');
  await f.objects.restore(await f.objects.read('hot.json'), fresh);
  assert.equal(await readFile(join(fresh, 'still-needed'), 'utf8'), 'shared data');
});
