import { realpath } from 'node:fs/promises';
import { relative, isAbsolute, resolve, sep } from 'node:path';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { CompositeVersionedSkillSource, LocalSkillSource } from '@mastra/core/workspace';
import type { SkillSource, VersionedSkillEntry } from '@mastra/core/workspace';

const isSkillDirectoryName = (id: string) => /^[a-z0-9][a-z0-9_-]*$/i.test(id);
const disabledCreatorSkills = new Set(['quality-assurance']);

export const creatorLocalSkillSource = (root: string) => new SharedSkillSource(root, disabledCreatorSkills);

export async function resolvePublishedSkills(storage: MastraCompositeStore) {
  const [skills, blobs] = await Promise.all([storage.getStore('skills'), storage.getStore('blobs')]);
  if (!skills || !blobs) throw new Error('Published skill storage is unavailable');

  const entries: VersionedSkillEntry[] = [];
  for (let page = 0; ; page++) {
    const result = await skills.list({ page, perPage: 100, status: 'published', visibility: 'public' });
    const records = result.skills.filter(
      record => record.activeVersionId && isSkillDirectoryName(record.id) && !disabledCreatorSkills.has(record.id),
    );
    const versions = await skills.getVersions(records.flatMap(record => record.activeVersionId ?? []));
    const byId = new Map(versions.map(version => [version.id, version]));
    for (const record of records) {
      // Resolve the published pointer explicitly. Generic version resolution can fall back to a draft.
      const version = byId.get(record.activeVersionId!);
      if (version?.skillId === record.id && version.tree) {
        entries.push({ dirName: record.id, tree: version.tree, versionCreatedAt: version.createdAt });
      }
    }
    if (!result.hasMore) break;
  }
  return new CompositeVersionedSkillSource(entries, blobs);
}

/** Shared instructions are read-only and may not resolve outside the skills root. */
export class SharedSkillSource implements SkillSource {
  private readonly local: LocalSkillSource;
  constructor(
    private readonly root: string,
    private readonly excluded?: ReadonlySet<string>,
  ) {
    this.local = new LocalSkillSource({ basePath: root });
  }
  private async checked(path: string) {
    const base = await realpath(this.root),
      target = await realpath(resolve(this.root, path));
    const rel = relative(base, target);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      throw new Error('Skill path is outside the shared skills directory.');
    if (this.excluded?.has(rel.split(sep)[0]))
      throw Object.assign(new Error('Skill is unavailable.'), { code: 'ENOENT' });
    return target;
  }
  async exists(path: string) {
    try {
      await this.checked(path);
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }
  async stat(path: string) {
    return this.local.stat(await this.checked(path));
  }
  async readFile(path: string) {
    return this.local.readFile(await this.checked(path));
  }
  async readdir(path: string) {
    const entries = await this.local.readdir(await this.checked(path));
    return this.excluded && resolve(this.root, path) === resolve(this.root)
      ? entries.filter(entry => !this.excluded!.has(entry.name))
      : entries;
  }
  async realpath(path: string) {
    return this.checked(path);
  }
}
