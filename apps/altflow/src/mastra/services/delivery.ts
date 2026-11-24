import type { DeliveryService, ToolIdentity } from '@mastra/altflow-tools';
import type { UserStorage } from '../user-storage';
import { filePath } from '../user-storage';

/** Same ledger and owner namespace as uploads and workspace file tools. */
export class UserDeliveryService implements DeliveryService {
  constructor(private readonly storage: Pick<UserStorage, 'info'>) {}
  async present(identity: ToolIdentity, files: Array<{ path: string; description?: string }>) {
    const unique = [...new Map(files.map(file => [filePath(file.path), file])).entries()];
    return Promise.all(
      unique.map(async ([path, file]) => {
        // info accepts regular files only; directories and missing/deleted files fail.
        const stored = await this.storage.info(identity.userId, path);
        return {
          path: stored.storagePath ?? stored.path,
          name: stored.name,
          size: stored.size,
          mimeType: stored.mimeType,
          downloadUrl: `/storage/download?${new URLSearchParams({ path: stored.storagePath ?? stored.path })}`,
          ...(file.description ? { description: file.description } : {}),
        };
      }),
    );
  }
}
