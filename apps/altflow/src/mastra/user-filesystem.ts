import { posix } from 'node:path';
import { FileNotFoundError, MastraFilesystem } from '@mastra/core/workspace';
import type {
  FileContent,
  ReadOptions,
  WriteOptions,
  RemoveOptions,
  CopyOptions,
  ListOptions,
  FileEntry,
  FileStat,
  ProviderStatus,
} from '@mastra/core/workspace';
import type { WorkspaceFiles } from './services/conversation-files';
import { decodePlainText, isPlainTextDocument } from './services/plain-text';
import { FileStorageError, filePath } from './user-storage.ts';

/** All agent file tools use the same private namespace and quota as uploads. */
export class UserFilesystem extends MastraFilesystem {
  readonly id: string;
  readonly name = '用户文件';
  readonly provider = 'aliyun-oss';
  status: ProviderStatus = 'ready';
  private store: WorkspaceFiles;
  private owner: string;
  constructor(store: WorkspaceFiles, owner: string) {
    super({ name: '用户文件' });
    this.store = store;
    this.owner = owner;
    this.id = `user-files-${owner}`;
  }
  async readFile(path: string, options?: ReadOptions) {
    try {
      const data = await this.store.read(this.owner, path);
      const encoding = options?.encoding;
      if ((encoding === 'utf-8' || encoding === 'utf8') && isPlainTextDocument(path)) return decodePlainText(data);
      return encoding ? data.toString(encoding) : data;
    } catch (error) {
      if (error instanceof FileStorageError && error.status === 404) throw new FileNotFoundError(path);
      throw error;
    }
  }
  async writeFile(path: string, content: FileContent, options?: WriteOptions) {
    await this.store.write(this.owner, path, Buffer.from(content), options);
  }
  async appendFile(path: string, content: FileContent) {
    let before = Buffer.alloc(0);
    let expectedMtime: Date | undefined;
    try {
      const info = await this.store.info(this.owner, path);
      before = await this.store.read(this.owner, path);
      expectedMtime = new Date(info.updatedAt);
    } catch (error) {
      if (!(error instanceof FileStorageError) || error.status !== 404) throw error;
    }
    await this.store.write(this.owner, path, Buffer.concat([before, Buffer.from(content)]), {
      expectedMtime,
      overwrite: Boolean(expectedMtime),
    });
  }
  async deleteFile(path: string, options?: RemoveOptions) {
    try {
      await this.store.remove(this.owner, path);
    } catch (error) {
      if (!(options?.force && error instanceof FileStorageError && error.status === 404)) throw error;
    }
  }
  async copyFile(src: string, dest: string, options?: CopyOptions) {
    const info = await this.store.info(this.owner, src);
    await this.store.write(this.owner, dest, await this.store.read(this.owner, src), {
      mimeType: info.mimeType,
      overwrite: options?.overwrite,
    });
  }
  async moveFile(src: string, dest: string, options?: CopyOptions) {
    if (filePath(src) === filePath(dest)) return;
    // Moving does not duplicate bytes: rename the ledger path in one transaction.
    await this.store.move(this.owner, src, dest, options?.overwrite);
  }
  async mkdir(path: string) {
    if (path !== '/' && path !== '.') await this.store.mkdir(this.owner, path);
  }
  async rmdir(input: string, options?: RemoveOptions) {
    const path = filePath(input);
    const files = (await this.store.list(this.owner)).filter(file => file.path.startsWith(path + '/'));
    const directories = await this.store.directories(this.owner);
    if (!options?.recursive && (files.length || directories.some(directory => directory.startsWith(path + '/'))))
      throw new FileStorageError('目录不为空');
    for (const file of files) await this.store.remove(this.owner, file.path);
    await this.store.rmdir(this.owner, path);
  }
  async readdir(input: string, options?: ListOptions): Promise<FileEntry[]> {
    const root = input === '/' || input === '.' ? '/' : filePath(input) + '/';
    const files = await this.store.list(this.owner);
    const directories = await this.store.directories(this.owner);
    const entries = new Map<string, FileEntry>();
    for (const file of [
      ...files.map(f => ({ path: f.path, size: f.size, directory: false })),
      ...directories.map(path => ({ path, size: 0, directory: true })),
    ]) {
      if (!file.path.startsWith(root)) continue;
      const relative = file.path.slice(root.length),
        segments = relative.split('/');
      if (!relative) continue;
      const depth = options?.recursive ? Math.min(segments.length, options.maxDepth ?? segments.length) : 1;
      for (let n = 1; n <= depth; n++) {
        const name = segments.slice(0, n).join('/');
        const directory = n < segments.length || file.directory;
        const extensions = options?.extension ? [options.extension].flat() : undefined;
        if (!directory && extensions && !extensions.some(extension => name.endsWith(extension))) continue;
        entries.set(name, {
          name,
          type: directory ? 'directory' : 'file',
          size: directory ? 0 : file.size,
        });
      }
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async exists(path: string) {
    try {
      await this.stat(path);
      return true;
    } catch (error) {
      if (error instanceof FileStorageError && error.status === 404) return false;
      throw error;
    }
  }
  async stat(input: string): Promise<FileStat> {
    if (input === '/' || input === '.')
      return {
        name: '/',
        path: '/',
        type: 'directory',
        size: 0,
        createdAt: new Date(0),
        modifiedAt: new Date(0),
      };
    const path = filePath(input);
    try {
      const file = await this.store.info(this.owner, path);
      return {
        name: file.name,
        path,
        type: 'file',
        size: file.size,
        mimeType: file.mimeType,
        createdAt: new Date(file.updatedAt),
        modifiedAt: new Date(file.updatedAt),
      };
    } catch (error) {
      if (!(error instanceof FileStorageError) || error.status !== 404) throw error;
      if (
        (await this.store.directories(this.owner)).some(
          directory => directory === path || directory.startsWith(path + '/'),
        ) ||
        (await this.store.list(this.owner)).some(file => file.path.startsWith(path + '/'))
      )
        return {
          name: posix.basename(path),
          path,
          type: 'directory',
          size: 0,
          createdAt: new Date(0),
          modifiedAt: new Date(0),
        };
      throw error;
    }
  }
}
