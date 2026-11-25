import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { publishSkillFromSource } from '@mastra/core/workspace';
import { LibSQLStore } from '@mastra/libsql';
import { SharedSkillSource } from '../src/mastra/services/shared-skills.ts';
import './environment.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const runtimeRoot = resolve(process.env.ALTFLOW_RUNTIME_ROOT ?? process.env.MASTRA_PREVIEW_ROOT ?? appRoot);
const source = new SharedSkillSource(resolve(appRoot, 'skills'));
const storage = new LibSQLStore({
  id: 'publish-creator-skills',
  url: `file:${resolve(runtimeRoot, 'src/mastra/public/preview.db')}`,
});
await storage.init();
const [skills, blobs] = await Promise.all([storage.getStore('skills'), storage.getStore('blobs')]);
for (const entry of await readdir(resolve(appRoot, 'skills'), { withFileTypes: true })) {
  if (!entry.isDirectory() || !(await source.exists(`${entry.name}/SKILL.md`))) continue;
  const id = entry.name;
  const existing = await skills.getById(id);
  if (existing && existing.visibility !== 'public') throw new Error(`Refusing to change visibility of ${id}`);
  const { snapshot, tree, files } = await publishSkillFromSource(source, id, blobs);
  const current = existing?.activeVersionId ? (await skills.getVersions([existing.activeVersionId]))[0] : undefined;
  if (current && isDeepStrictEqual(current.tree, tree)) {
    console.log(`${id}: active version unchanged`);
    continue;
  }
  if (existing) await skills.update({ id, ...snapshot, tree, files });
  else await skills.create({ skill: { id, ...snapshot, visibility: 'public', tree, files } });
  const version = await skills.getLatestVersion(id);
  if (!version) throw new Error(`Missing new version for ${id}`);
  await skills.update({ id, activeVersionId: version.id });
  console.log(`${id}: published v${version.versionNumber}`);
}
await storage.close();
