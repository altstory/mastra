import type { MastraCompositeStore } from '@mastra/core/storage';
import { Workspace } from '@mastra/core/workspace';
import { resolvePublishedSkills } from '../services/shared-skills';
import { UserFilesystem } from '../user-filesystem';
import type { WorkspaceFiles } from '../services/conversation-files';

export function createPrivateWorkspace(files: WorkspaceFiles, storage: MastraCompositeStore) {
  return async (user: { id: string; role?: string }) => {
    const workspace = new Workspace({
      id: `files-${user.id}`,
      name: '我的文件',
      filesystem: new UserFilesystem(files, user.id),
      ...(user.role === 'admin' && { skills: ['.'], skillSource: await resolvePublishedSkills(storage) }),
    });
    await workspace.init();
    return workspace;
  };
}
