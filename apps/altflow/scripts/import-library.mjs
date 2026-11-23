// Seeds the shared creator library (scope `library:creator`) from knowledge/library/*.md.
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
const PAGES = [
  { file: 'genre-first-principles', path: 'research/genre-first-principles', name: '短剧类型第一性原理分析', description: '用一个词概括每种短剧类型的底层逻辑，用于类型判断、策划和互动设计。' },
  { file: 'male-short-drama-hit-cases', path: 'research/male-short-drama-hit-cases', name: '男频爆款短剧案例分析', description: '提炼男频短剧爆款案例的成功规律，用于对标和改编参考。' },
  { file: 'male-short-drama-audience', path: 'research/male-short-drama-audience', name: '男频短剧用户画像', description: '男频短剧用户的分层、核心群体与需求，用于受众分析。' },
  { file: 'interactive-audience-shift', path: 'research/interactive-audience-shift', name: '互动短剧用户画像变化', description: '短剧加入互动后用户群体的流失与新增，用于互动设计与受众判断。' },
  { file: 'interaction-experiences', path: 'method/interaction-experiences', name: '四类主互动体验设计要点', description: '情感抉择、命运逆转、权谋博弈、生存闯关四类主互动体验的口径、状态、选项数量、反馈与钩子倾向。' },
  { file: 'interaction-dimensions', path: 'method/interaction-dimensions', name: '互动设计四维度问题清单', description: '节奏、钩子、选择机制、状态与反馈四个维度的问题，按四类体验分别改写，以及风险校验。' },
  { file: 'relationship-choice-prototypes', path: 'method/relationship-choice-prototypes', name: '关系抉择原型', description: '情感抉择类作品的关系模式、状态字段、互动题型样例、关系钩子、弧线阶段与选项设计铁律。' },
  { file: 'node-type-groups', path: 'method/node-type-groups', name: '互动节点类型组', description: '按题材与互动重心划分的四组互动节点类型，含默认占比与每集上限。' },
];

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
