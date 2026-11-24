import { createClient } from '@libsql/client';
import type { Client } from '@libsql/client';
import { z } from 'zod';

const address = {
  kind: z.enum(['author_preference', 'project_agreement', 'story_fact']),
  key: z.string().trim().min(1).max(100),
  revision: z.number().int().nonnegative(),
  evidence: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe('本轮用户明确陈述、确认或要求删除的原话，不能引用 Agent 建议或资料正文'),
};
export const rememberSchema = z
  .object({
    ...address,
    status: z.literal('confirmed'),
    content: z.string().trim().min(1).max(600),
    version: z.string().trim().min(1).max(100).optional(),
    document: z.string().min(1).max(1024).optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'story_fact' && !value.version)
      ctx.addIssue({ code: 'custom', path: ['version'], message: '作品事实必须注明适用版本' });
    if (value.document && !value.version)
      ctx.addIssue({ code: 'custom', path: ['version'], message: '采用文档时必须注明版本' });
    if (value.kind === 'author_preference' && (value.document || value.version))
      ctx.addIssue({ code: 'custom', message: '作品文档与版本不能存成作者偏好' });
  });
export const forgetMemorySchema = z.object(address).strict();
export type MemoryKind = z.infer<typeof forgetMemorySchema>['kind'];
export interface MemorySource {
  threadId: string;
  messageId: string;
  quote: string;
}
export interface CreativeMemoryEntry {
  kind: MemoryKind;
  key: string;
  revision: number;
  status: 'confirmed' | 'deleted';
  content?: string;
  version?: string;
  document?: { path: string; storagePath?: string; updatedAt: string };
  expiresAt?: string;
  source: MemorySource;
  updatedAt: string;
}

export class CreativeMemoryStore {
  private db: Client;
  constructor(url: string) {
    this.db = createClient({ url });
  }
  async init() {
    await this.db.execute(`CREATE TABLE IF NOT EXISTS creative_memory (
      owner TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
      value TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY (owner, scope, kind, key)
    )`);
    await this.db.execute('PRAGMA busy_timeout = 10000');
  }
  close() {
    this.db.close();
  }
  async read(owner: string, projectId?: string): Promise<CreativeMemoryEntry[]> {
    const result = await this.db.execute({
      sql: 'SELECT value FROM creative_memory WHERE owner = ? AND (scope = ? OR scope = ?) ORDER BY kind, key',
      args: [owner, 'author', projectId ? `project:${projectId}` : 'author'],
    });
    return result.rows.map(row => JSON.parse(String(row.value)) as CreativeMemoryEntry);
  }
  async write(
    owner: string,
    projectId: string | undefined,
    expectedRevision: number,
    entry: Omit<CreativeMemoryEntry, 'revision' | 'updatedAt'>,
  ) {
    if (entry.kind !== 'author_preference' && !projectId) throw new Error('当前会话未关联项目，不能保存项目记忆');
    const scope = entry.kind === 'author_preference' ? 'author' : `project:${projectId}`;
    const value: CreativeMemoryEntry = {
      ...entry,
      revision: expectedRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    const result = await this.db.execute({
      sql: `INSERT INTO creative_memory(owner, scope, kind, key, value, revision)
        SELECT :owner, :scope, :kind, :key, :value, :expected + 1
        WHERE COALESCE((SELECT revision FROM creative_memory
          WHERE owner = :owner AND scope = :scope AND kind = :kind AND key = :key), 0) = :expected
        AND (:deleted = 1 OR EXISTS (SELECT 1 FROM creative_memory
          WHERE owner = :owner AND scope = :scope AND kind = :kind AND key = :key
            AND json_extract(value, '$.status') != 'deleted')
          OR (SELECT count(*) FROM creative_memory WHERE owner = :owner AND scope = :scope
            AND json_extract(value, '$.status') != 'deleted') < 64)
        ON CONFLICT(owner, scope, kind, key) DO UPDATE SET value = excluded.value, revision = excluded.revision
        RETURNING value`,
      args: {
        owner,
        scope,
        kind: entry.kind,
        key: entry.key,
        value: JSON.stringify(value),
        expected: expectedRevision,
        deleted: entry.status === 'deleted' ? 1 : 0,
      },
    });
    if (!result.rows.length) throw new Error('记忆已更新或当前范围已满，请重新读取后更正或合并已有条目');
    return value;
  }
}
