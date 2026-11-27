import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Knowledge } from '@mastra/core/knowledge';
import { buildMessageEmbeddingRows, resolveMaxChunkChars } from '@mastra/core/memory';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { createModelHubEmbedder, EMBEDDING_DIMENSION, embedTextBatch } from '../src/mastra/embedding.ts';
import { modelCredential } from './environment.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(process.env.ALTFLOW_RUNTIME_ROOT ?? process.env.MASTRA_PREVIEW_ROOT ?? appRoot);
const previewPath = resolve(root, 'src/mastra/public/preview.db');
const vectorPath = resolve(root, 'data/vectors.db');
if (process.argv.includes('--prepare-deployment')) {
  const current = await stat(vectorPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (current) {
    const db = new DatabaseSync(vectorPath, { readOnly: true });
    let indexes;
    try {
      indexes = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND sql LIKE '%F32_BLOB%'").all();
    } finally {
      db.close();
    }
    if (
      indexes.length &&
      indexes.every(index => Number(/F32_BLOB\((\d+)\)/i.exec(index.sql)?.[1]) === EMBEDDING_DIMENSION)
    ) {
      process.exit(0);
    }
  }
  const source = await stat(previewPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (source) modelCredential();
  for (const suffix of ['', '-wal', '-shm']) await rm(vectorPath + suffix, { force: true });
  if (!source) process.exit(0);
}

const embedder = createModelHubEmbedder({
  apiKey: modelCredential(),
  baseURL: process.env.ALTFLOW_MODELHUB_BASE_URL,
  retries: 4,
  timeoutMs: 30_000,
});
const messageIndex = `memory_messages_${EMBEDDING_DIMENSION}`;

async function fingerprint() {
  return Promise.all(
    [previewPath, vectorPath]
      .flatMap(path => [path, path + '-wal'])
      .map(async path => {
        const info = await stat(path, { bigint: true }).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        return info && !(path.endsWith('-wal') && info.size === 0n) ? `${info.ino}:${info.size}:${info.mtimeNs}` : null;
      }),
  ).then(files => JSON.stringify(files));
}

async function rebuildMessages(storage, vector) {
  const memory = await storage.getStore('memory');
  if (!memory) throw new Error('Conversation storage is unavailable');
  const maxChunkChars = resolveMaxChunkChars({ embedder });
  let count = 0;
  for (let threadPage = 0; ; threadPage++) {
    const { threads, hasMore: moreThreads } = await memory.listThreads({ page: threadPage, perPage: 100 });
    for (const thread of threads) {
      for (let page = 0; ; page++) {
        const { messages, hasMore } = await memory.listMessages({ threadId: thread.id, page, perPage: 50 });
        const { ids, documents, metadata } = await buildMessageEmbeddingRows({
          items: messages.map(message => ({ message })),
          maxChunkChars,
          loadThreadMetadata: async () => new Map([[thread.id, thread.metadata ?? {}]]),
        });
        if (ids.length) {
          await vector.createIndex({ indexName: messageIndex, dimension: EMBEDDING_DIMENSION });
          for (let offset = 0; offset < ids.length; offset += embedder.maxEmbeddingsPerCall) {
            const end = offset + embedder.maxEmbeddingsPerCall;
            await vector.upsert({
              indexName: messageIndex,
              ids: ids.slice(offset, end),
              metadata: metadata.slice(offset, end),
              vectors: await embedTextBatch(embedder, documents.slice(offset, end)),
            });
          }
          count += ids.length;
        }
        if (!hasMore) break;
      }
    }
    if (!moreThreads) return count;
  }
}

function closeJournal(path) {
  const db = new DatabaseSync(path);
  try {
    if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy) {
      throw new Error('Stop AltFlow before replacing the vector database.');
    }
    if (db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') {
      throw new Error('Could not close the vector journal.');
    }
  } finally {
    db.close();
  }
}

await mkdir(resolve(root, 'data'), { recursive: true });
const before = await fingerprint();
await embedTextBatch(embedder, ['AltFlow embedding index check']);
const directory = await mkdtemp(resolve(root, 'data/.embedding-rebuild-'));
try {
  const snapshotPath = resolve(directory, 'preview.db');
  const source = new DatabaseSync(previewPath, { readOnly: true });
  try {
    await backup(source, snapshotPath, { rate: 256 });
  } finally {
    source.close();
  }
  const replacement = resolve(directory, 'vectors.db');
  const storage = new LibSQLStore({ id: 'embedding-rebuild-source', url: `file:${snapshotPath}` });
  const vector = new LibSQLVector({ id: 'embedding-rebuild', url: `file:${replacement}` });
  try {
    const knowledge = new Knowledge({
      id: 'creator-knowledge',
      storage,
      vector,
      embedder,
      embedderOptions: { maxRetries: 0 },
      scopes: {},
    });
    let cursor;
    let pages = 0;
    let notes = 0;
    do {
      const batch = await knowledge.reembed({ limit: 50, cursor });
      if (batch.rateLimited || batch.failed.length) {
        throw new Error(
          `Knowledge rebuild stopped (${batch.rateLimited ? 'gateway rate limit' : batch.failed.map(f => f.kind + ':' + f.id).join(', ')})`,
        );
      }
      pages += batch.embedded.pages;
      notes += batch.embedded.notes;
      cursor = batch.nextCursor;
      console.log(`Knowledge: ${pages} pages, ${notes} notes`);
    } while (cursor);
    console.log(`Conversation: ${await rebuildMessages(storage, vector)} vectors`);
    for (const indexName of await vector.listIndexes()) {
      const stats = await vector.describeIndex({ indexName });
      if (stats.dimension !== EMBEDDING_DIMENSION) throw new Error(`Unexpected vector dimension in ${indexName}`);
      console.log(`${indexName}: ${stats.count} vectors, ${stats.dimension} dimensions`);
    }
  } finally {
    await vector.close();
    await storage.close();
  }
  if ((await fingerprint()) !== before) {
    throw new Error('The source databases changed during rebuild. Stop AltFlow and retry.');
  }

  closeJournal(replacement);
  for (const suffix of ['-wal', '-shm']) await rm(vectorPath + suffix, { force: true });
  await rename(replacement, vectorPath);
  console.log(`Replaced vector database with ${embedder.modelId}: ${vectorPath}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
