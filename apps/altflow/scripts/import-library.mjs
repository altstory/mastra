// Seeds the shared creator library (scope `library:creator`) from knowledge/library/manifest.json.
// Idempotent: upsertPage reports created / updated / unchanged. Run: node --import tsx scripts/import-library.mjs (data root: ALTFLOW_RUNTIME_ROOT)
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Knowledge, knowledgeMemoryScopes } from '@mastra/core/knowledge';
import { MastraCompositeStore } from '@mastra/core/storage';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { localEmbedder } from '../src/mastra/embedding.ts';
import './environment.mjs';

// Same data-root rule as the server (src/mastra/index.ts) and its launchers, so this writes the
// databases the running service reads. The page sources ship with the app, not with the data.
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(process.env.ALTFLOW_RUNTIME_ROOT ?? process.env.MASTRA_PREVIEW_ROOT ?? appRoot);
const sourceDir = resolve(appRoot, 'knowledge/library');
const SCOPE = 'library:creator';
const PAGES = JSON.parse(await readFile(resolve(sourceDir, 'manifest.json'), 'utf8'));

const storage = new MastraCompositeStore({
  id: 'creator-preview-storage',
  default: new LibSQLStore({ id: 'preview-storage', url: `file:${resolve(root, 'src/mastra/public/preview.db')}` }),
});
const vector = new LibSQLVector({ id: 'creator-vectors', url: `file:${resolve(root, 'data/vectors.db')}` });
const knowledge = new Knowledge({
  id: 'creator-knowledge',
  name: '创作知识库',
  description: '创作方法、素材和作者偏好。',
  storage,
  vector,
  embedder: localEmbedder,
  tools: true,
  pinnedContext: true,
  scopes: {
    ...knowledgeMemoryScopes({ org: false }),
    'audience:$audience': { displayLabel: '创作者', access: [{ principal: 'self', role: 'viewer' }] },
    'library:$libraryId': {
      displayLabel: '创作资料',
      description: '管理员维护的共享创作方法库。',
      access: [
        { principal: 'self', role: 'owner' },
        { principal: 'audience:creators', role: 'viewer' },
      ],
    },
  },
});

for (const page of PAGES) {
  const body = await readFile(resolve(sourceDir, `${page.file}.md`), 'utf8');
  const result = await knowledge.upsertPage({ scope: SCOPE, path: page.path, name: page.name, description: page.description, body, author: 'library-import' });
  console.log(result.status.padEnd(9), page.path);
}
