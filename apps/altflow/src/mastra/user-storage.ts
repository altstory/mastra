import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@libsql/client';
import type { Client, Transaction, Row } from '@libsql/client';
import type OSS from 'ali-oss';
import {
  fileChangeSummary,
  recordTurnFile,
  snapshotLimit,
  textSnapshot,
  trackTurnFiles,
  turnChangesSchema,
} from './services/turn-file-changes';

export const USER_STORAGE_QUOTA = 512 * 1024 * 1024;
export class FileStorageError extends Error {
  status: 400 | 404 | 409 | 413 | 503;
  constructor(message: string, status: 400 | 404 | 409 | 413 | 503 = 400) {
    super(message);
    this.status = status;
  }
}
export type UserFile = {
  path: string;
  storagePath?: string;
  name: string;
  size: number;
  mimeType: string;
  source: 'upload' | 'generated';
  updatedAt: string;
};
export function filePath(input: string) {
  if (!input || input.includes('\\') || /[\x00-\x1f]/.test(input) || input.split('/').includes('..'))
    throw new FileStorageError('文件路径无效');
  const path = posix.normalize('/' + input.replace(/^\/+/, ''));
  if (path === '/' || path.length > 1024) throw new FileStorageError('文件路径无效');
  return path;
}
const field = (row: Row, name: string) => String(row[name]);
const toFile = (row: Row): UserFile => ({
  path: field(row, 'path'),
  name: posix.basename(field(row, 'path')),
  size: Number(row.size),
  mimeType: field(row, 'mime'),
  source: row.source === 'upload' ? 'upload' : 'generated',
  updatedAt: field(row, 'updated'),
});
const mimeFor = (path: string) =>
  ({
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })[posix.extname(path).toLowerCase()] ?? 'application/octet-stream';

/** Private OSS blobs; this ledger is the only namespace and quota authority.
 * Transactions reserve bytes before network I/O. A crashed write keeps its reservation
 * until recovery deletes its immutable object. Never infer ownership from client paths.
 */
export class UserStorage {
  private db: Client;
  private client: OSS;
  readonly quota: number;
  constructor(options: { client: OSS; databaseUrl: string; authToken?: string; quota?: number }) {
    this.db = createClient({ url: options.databaseUrl, authToken: options.authToken });
    this.client = options.client;
    this.quota = options.quota ?? USER_STORAGE_QUOTA;
  }
  async init() {
    // A dedicated application-owned ledger, separate from conversation/user databases.
    await this.db.executeMultiple(`
      CREATE TABLE IF NOT EXISTS user_files (
        owner TEXT NOT NULL, path TEXT NOT NULL, object_key TEXT NOT NULL, size INTEGER NOT NULL,
        mime TEXT NOT NULL, source TEXT NOT NULL, digest TEXT NOT NULL, updated TEXT NOT NULL,
        PRIMARY KEY(owner, path));
      CREATE TABLE IF NOT EXISTS file_operations (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, path TEXT NOT NULL, object_key TEXT NOT NULL,
        old_key TEXT, reserved INTEGER NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL,
        UNIQUE(owner, path));
      CREATE TABLE IF NOT EXISTS file_garbage (object_key TEXT PRIMARY KEY, owner TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS user_directories (owner TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(owner,path));
      CREATE TABLE IF NOT EXISTS conversation_files (
        owner TEXT NOT NULL, thread TEXT NOT NULL, path TEXT NOT NULL,
        PRIMARY KEY(owner,thread,path));
    `);
    await this.db.executeMultiple(turnChangesSchema);
    await this.recover();
  }
  close() {
    this.db.close();
  }
  private async transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    // libSQL's local driver reports SQLITE_BUSY immediately; retry asynchronously so
    // the current writer can commit, including writers in another worker process.
    let tx: Transaction | undefined;
    for (let attempt = 0; !tx; attempt++) {
      try {
        tx = await this.db.transaction('write');
      } catch (error) {
        if (attempt >= 50 || !(error instanceof Error) || !('code' in error) || error.code !== 'SQLITE_BUSY')
          throw error;
        await delay(Math.min(100, 5 * (attempt + 1)));
      }
    }
    try {
      const value = await operation(tx);
      await tx.commit();
      return value;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  }
  private async row(owner: string, path: string) {
    const result = await this.db.execute({
      sql: 'SELECT * FROM user_files WHERE owner=? AND path=?',
      args: [owner, filePath(path)],
    });
    return result.rows[0];
  }
  async list(owner: string): Promise<UserFile[]> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM user_files WHERE owner=? ORDER BY updated DESC, path',
      args: [owner],
    });
    return result.rows.map(toFile);
  }
  async conversationLinks(owner: string, thread: string) {
    const result = await this.db.execute({
      sql: `SELECT f.* FROM user_files f JOIN conversation_files c ON f.owner=c.owner AND f.path=c.path
        WHERE c.owner=? AND c.thread=?`,
      args: [owner, thread],
    });
    return result.rows.map(toFile);
  }
  async linkConversationUpload(owner: string, thread: string, path: string) {
    await this.db.execute({
      sql: `INSERT OR IGNORE INTO conversation_files SELECT owner,?,path FROM user_files
        WHERE owner=? AND path=? AND source='upload' AND substr(path,1,9)='/uploads/'`,
      args: [thread, owner, filePath(path)],
    });
  }
  async linkLegacyConversationFiles(owner: string, thread: string) {
    await this.db.execute({
      sql: `INSERT OR IGNORE INTO conversation_files
        SELECT f.owner,?,f.path FROM user_files f
        WHERE f.owner=? AND substr(f.path,1,15) != '/conversations/'
          AND EXISTS (SELECT 1 FROM turn_file_changes c WHERE c.owner=f.owner AND c.path=f.path
            AND c.thread=? AND c.after_digest=f.digest)
          AND NOT EXISTS (SELECT 1 FROM turn_file_changes c WHERE c.owner=f.owner AND c.path=f.path AND c.thread!=?)`,
      args: [thread, owner, thread, thread],
    });
  }
  async summary(owner: string) {
    const result = await this.db.execute({
      sql: `SELECT
      (SELECT COALESCE(SUM(size),0) FROM user_files WHERE owner=?) AS used,
      (SELECT COALESCE(SUM(reserved),0) FROM file_operations WHERE owner=?) AS reserved`,
      args: [owner, owner],
    });
    return {
      quotaBytes: this.quota,
      usedBytes: Number(result.rows[0].used),
      reservedBytes: Number(result.rows[0].reserved),
    };
  }
  async info(owner: string, path: string) {
    const row = await this.row(owner, path);
    if (!row) throw new FileStorageError('文件不存在', 404);
    return toFile(row);
  }
  async read(owner: string, path: string) {
    const row = await this.row(owner, path);
    if (!row) throw new FileStorageError('文件不存在', 404);
    try {
      const result = await this.client.get(field(row, 'object_key'));
      return Buffer.from(result.content);
    } catch {
      throw new FileStorageError('文件暂时无法读取，请稍后重试', 503);
    }
  }
  async write(
    owner: string,
    input: string,
    data: Buffer,
    options: {
      mimeType?: string;
      source?: 'upload' | 'generated';
      overwrite?: boolean;
      expectedMtime?: Date;
    } = {},
  ) {
    const path = filePath(input);
    if (data.length > this.quota) throw new FileStorageError('存储空间不足，每个用户可使用 512 MB', 413);
    const digest = createHash('sha256').update(data).digest('hex');
    const id = randomUUID();
    const prefix = createHash('sha256').update(owner).digest('hex');
    const objectKey = `users/${prefix}/objects/${id}`;
    const previous = await this.transaction(async tx => {
      const row = (
        await tx.execute({
          sql: 'SELECT * FROM user_files WHERE owner=? AND path=?',
          args: [owner, path],
        })
      ).rows[0];
      if (row && options.overwrite === false) {
        // Upload retries keep a stable path; identical bytes do not consume space twice.
        if (field(row, 'digest') === digest) return { duplicate: toFile(row) };
        throw new FileStorageError('同名文件已存在', 409);
      }
      if (
        options.expectedMtime &&
        (!row || new Date(field(row, 'updated')).getTime() !== options.expectedMtime.getTime())
      )
        throw new FileStorageError('文件已更新，请重新读取后修改', 409);
      const busy = await tx.execute({
        sql: 'SELECT id FROM file_operations WHERE owner=? AND path=?',
        args: [owner, path],
      });
      if (busy.rows.length) throw new FileStorageError('文件正在更新，请重试', 409);
      const reserved = Math.max(0, data.length - Number(row?.size ?? 0));
      const usage = (
        await tx.execute({
          sql: `SELECT
        (SELECT COALESCE(SUM(size),0) FROM user_files WHERE owner=?) +
        (SELECT COALESCE(SUM(reserved),0) FROM file_operations WHERE owner=?) AS bytes`,
          args: [owner, owner],
        })
      ).rows[0];
      if (Number(usage.bytes) + reserved > this.quota)
        throw new FileStorageError('存储空间不足，请在设置中删除文件后重试（共 512 MB）', 413);
      await tx.execute({
        sql: 'INSERT INTO file_operations VALUES (?,?,?,?,?,?,?,?)',
        args: [id, owner, path, objectKey, row ? field(row, 'object_key') : null, reserved, 'write', Date.now()],
      });
      return {
        oldRow: row,
        oldKey: row ? field(row, 'object_key') : undefined,
        oldUpdated: row ? new Date(field(row, 'updated')).getTime() : 0,
      };
    });
    if (previous.duplicate) return previous.duplicate;
    const mime = options.mimeType ?? mimeFor(path);
    const updated = new Date(Math.max(Date.now(), (previous.oldUpdated ?? 0) + 1)).toISOString();
    const before = await this.fileVersion(owner, path, previous.oldRow);
    const after = { digest, text: textSnapshot(path, data) };
    try {
      await this.client.put(objectKey, data, { mime, headers: { 'x-oss-object-acl': 'private' } });
      await this.transaction(async tx => {
        await tx.execute({
          sql: 'INSERT OR REPLACE INTO user_files VALUES (?,?,?,?,?,?,?,?)',
          args: [owner, path, objectKey, data.length, mime, options.source ?? 'generated', digest, updated],
        });
        if (previous.oldKey)
          await tx.execute({
            sql: 'INSERT OR IGNORE INTO file_garbage VALUES (?,?,?)',
            args: [previous.oldKey, owner, Date.now()],
          });
        await recordTurnFile(tx, owner, path, before, after);
        await tx.execute({ sql: 'DELETE FROM file_operations WHERE id=?', args: [id] });
      });
    } catch (error) {
      // Retain the reservation if cleanup fails; recovery will retry it later.
      await this.client
        .delete(objectKey)
        .then(() =>
          this.transaction(async tx => {
            await tx.execute({ sql: 'DELETE FROM file_operations WHERE id=?', args: [id] });
          }),
        )
        .catch(() => {});
      // Raw OSS errors can contain signed request headers. Do not expose them to tools.
      throw error instanceof FileStorageError ? error : new FileStorageError('文件暂时无法保存，请稍后重试', 503);
    }
    // Old immutable blobs are garbage after the new ledger entry commits.
    if (previous.oldKey) await this.collectGarbage(previous.oldKey);
    return {
      path,
      name: posix.basename(path),
      size: data.length,
      mimeType: mime,
      source: options.source ?? 'generated',
      updatedAt: updated,
    };
  }
  async remove(owner: string, input: string) {
    const path = filePath(input),
      id = randomUUID();
    const row = await this.transaction(async tx => {
      if (
        (
          await tx.execute({
            sql: 'SELECT id FROM file_operations WHERE owner=? AND path=?',
            args: [owner, path],
          })
        ).rows.length
      )
        throw new FileStorageError('文件正在更新，请重试', 409);
      const row = (
        await tx.execute({
          sql: 'SELECT * FROM user_files WHERE owner=? AND path=?',
          args: [owner, path],
        })
      ).rows[0];
      if (!row) throw new FileStorageError('文件不存在', 404);
      await tx.execute({
        sql: 'INSERT INTO file_operations VALUES (?,?,?,?,?,?,?,?)',
        args: [id, owner, path, field(row, 'object_key'), null, 0, 'delete', Date.now()],
      });
      return row;
    });
    const before = await this.fileVersion(owner, path, row);
    // Never release quota while the object still exists.
    try {
      await this.client.delete(field(row, 'object_key'));
    } catch {
      await this.transaction(async tx => {
        await tx.execute({ sql: 'DELETE FROM file_operations WHERE id=?', args: [id] });
      });
      throw new FileStorageError('文件暂时无法删除，请稍后重试', 503);
    }
    await this.transaction(async tx => {
      await tx.execute({
        sql: 'DELETE FROM user_files WHERE owner=? AND path=?',
        args: [owner, path],
      });
      await recordTurnFile(tx, owner, path, before, null);
      await tx.execute({ sql: 'DELETE FROM file_operations WHERE id=?', args: [id] });
    });
  }
  async directories(owner: string) {
    return (
      await this.db.execute({
        sql: 'SELECT path FROM user_directories WHERE owner=?',
        args: [owner],
      })
    ).rows.map(row => field(row, 'path'));
  }
  async move(owner: string, from: string, to: string, overwrite = true) {
    const src = filePath(from),
      dest = filePath(to);
    if (src === dest) return;
    const garbage = await this.transaction(async tx => {
      if (
        (
          await tx.execute({
            sql: 'SELECT id FROM file_operations WHERE owner=? AND path IN (?,?)',
            args: [owner, src, dest],
          })
        ).rows.length
      )
        throw new FileStorageError('文件正在更新，请重试', 409);
      const source = (
        await tx.execute({
          sql: 'SELECT * FROM user_files WHERE owner=? AND path=?',
          args: [owner, src],
        })
      ).rows[0];
      if (!source) throw new FileStorageError('文件不存在', 404);
      const target = (
        await tx.execute({
          sql: 'SELECT * FROM user_files WHERE owner=? AND path=?',
          args: [owner, dest],
        })
      ).rows[0];
      if (target && !overwrite) throw new FileStorageError('同名文件已存在', 409);
      if (trackTurnFiles.getStore()?.owner === owner) {
        const [beforeSource, beforeTarget, afterTarget] = await Promise.all([
          this.fileVersion(owner, src, source),
          this.fileVersion(owner, dest, target),
          this.fileVersion(owner, dest, source),
        ]);
        await recordTurnFile(tx, owner, src, beforeSource, null);
        await recordTurnFile(tx, owner, dest, beforeTarget, afterTarget);
      }
      await tx.execute({
        sql: 'DELETE FROM user_files WHERE owner=? AND path=?',
        args: [owner, dest],
      });
      await tx.execute({
        sql: 'UPDATE user_files SET path=?,updated=? WHERE owner=? AND path=?',
        args: [dest, new Date().toISOString(), owner, src],
      });
      if (target)
        await tx.execute({
          sql: 'INSERT OR IGNORE INTO file_garbage VALUES (?,?,?)',
          args: [field(target, 'object_key'), owner, Date.now()],
        });
      return target ? field(target, 'object_key') : undefined;
    });
    if (garbage) await this.collectGarbage(garbage);
  }
  async mkdir(owner: string, path: string) {
    await this.transaction(async tx => {
      await tx.execute({
        sql: 'INSERT OR IGNORE INTO user_directories VALUES (?,?)',
        args: [owner, filePath(path)],
      });
    });
  }
  async rmdir(owner: string, path: string) {
    await this.transaction(async tx => {
      await tx.execute({
        sql: 'DELETE FROM user_directories WHERE owner=? AND (path=? OR substr(path,1,?)=?)',
        args: [owner, path, path.length + 1, path + '/'],
      });
    });
  }
  async turnChanges(owner: string, thread: string) {
    const result = await this.db.execute({
      sql: `SELECT turn,path,before_digest,after_digest,before_text IS NOT NULL AS has_before,
        after_text IS NOT NULL AS has_after FROM turn_file_changes
        WHERE owner=? AND thread=? AND before_digest IS NOT after_digest ORDER BY updated DESC LIMIT 500`,
      args: [owner, thread],
    });
    return result.rows.map(row => ({
      turn: field(row, 'turn'),
      ...fileChangeSummary(
        field(row, 'path'),
        row.before_digest,
        row.after_digest,
        row.has_before ? '' : null,
        row.has_after ? '' : null,
      ),
    }));
  }

  async turnDiff(owner: string, thread: string, turn: string, path: string) {
    const result = await this.db.execute({
      sql: `SELECT before_digest,after_digest,before_text,after_text FROM turn_file_changes
        WHERE owner=? AND thread=? AND turn=? AND path=? AND before_digest IS NOT after_digest`,
      args: [owner, thread, turn, filePath(path)],
    });
    const row = result.rows[0];
    if (!row) throw new FileStorageError('文件变更不存在', 404);
    return { before: row.before_text, after: row.after_text };
  }

  private async fileVersion(owner: string, path: string, row: Row | undefined) {
    if (!row || trackTurnFiles.getStore()?.owner !== owner) return null;
    let text = null;
    if (/\.(md|markdown|txt)$/i.test(path) && Number(row.size) <= snapshotLimit) {
      // Immutable object keys are reserved by the active operation.
      const object = await this.client.get(field(row, 'object_key')).catch(() => undefined);
      if (object) text = textSnapshot(path, Buffer.from(object.content));
    }
    return { digest: field(row, 'digest'), text };
  }

  private async collectGarbage(key: string) {
    try {
      await this.client.delete(key);
      await this.transaction(async tx => {
        await tx.execute({ sql: 'DELETE FROM file_garbage WHERE object_key=?', args: [key] });
      });
    } catch {
      /* Keep the durable cleanup entry until OSS deletion succeeds. */
    }
  }
  async recover() {
    const garbage = await this.db.execute('SELECT object_key FROM file_garbage');
    for (const row of garbage.rows) await this.collectGarbage(field(row, 'object_key'));
    // SDK timeout is 30s. A one-hour grace period cannot reclaim an active upload.
    const stale = await this.db.execute({
      sql: 'SELECT * FROM file_operations WHERE created<?',
      args: [Date.now() - 3600_000],
    });
    for (const row of stale.rows) {
      try {
        await this.client.delete(field(row, 'object_key'));
        await this.transaction(async tx => {
          if (row.kind === 'delete')
            await tx.execute({
              sql: 'DELETE FROM user_files WHERE owner=? AND path=?',
              args: [field(row, 'owner'), field(row, 'path')],
            });
          await tx.execute({
            sql: 'DELETE FROM file_operations WHERE id=?',
            args: [field(row, 'id')],
          });
        });
      } catch {
        /* Keep failed cleanup reserved for the next recovery pass. */
      }
    }
  }
}
