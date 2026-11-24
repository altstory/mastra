import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Processor } from '@mastra/core/processors';
import type { RequestContext } from '@mastra/core/request-context';
import { FileStorageError, filePath } from '../user-storage';
import type { UserFile, UserStorage } from '../user-storage';

export type FileScope = { owner: string; root: string };
export type WorkspaceFiles = Pick<
  UserStorage,
  'list' | 'info' | 'read' | 'write' | 'remove' | 'directories' | 'move' | 'mkdir' | 'rmdir'
>;

/** Tools share a scope only within an authenticated conversation and its child agents. */
export class ConversationFiles implements WorkspaceFiles {
  private context = new AsyncLocalStorage<FileScope>();
  constructor(private readonly storage: UserStorage) {}

  run<T>(scope: FileScope, action: () => T): T {
    return this.context.run(scope, action);
  }
  private scope(owner: string) {
    const scope = this.context.getStore();
    if (!scope || scope.owner !== owner || !scope.root) throw new FileStorageError('需要当前会话的文件访问权限', 404);
    return { ...scope, prefix: `/conversations/${createHash('sha256').update(scope.root).digest('hex')}` };
  }
  private logical(owner: string, path: string) {
    const { prefix } = this.scope(owner);
    const normalized = filePath(path);
    return normalized.startsWith(prefix + '/') ? normalized.slice(prefix.length) : normalized;
  }
  private physical(owner: string, path: string) {
    return this.scope(owner).prefix + this.logical(owner, path);
  }
  private project(file: UserFile, path: string): UserFile {
    return { ...file, path, storagePath: file.path };
  }
  async list(owner: string) {
    if (!this.context.getStore()) return [];
    const scope = this.scope(owner);
    const files = new Map((await this.storage.conversationLinks(owner, scope.root)).map(file => [file.path, file]));
    for (const file of await this.storage.list(owner)) {
      if (file.path.startsWith(scope.prefix + '/')) {
        const path = file.path.slice(scope.prefix.length);
        files.set(path, this.project(file, path));
      }
    }
    return [...files.values()];
  }
  async info(owner: string, path: string) {
    const scope = this.scope(owner);
    path = this.logical(owner, path);
    try {
      return this.project(await this.storage.info(owner, this.physical(owner, path)), path);
    } catch (error) {
      if (!(error instanceof FileStorageError) || error.status !== 404) throw error;
      const linked = (await this.storage.conversationLinks(owner, scope.root)).find(file => file.path === path);
      if (!linked) throw error;
      return this.project(linked, path);
    }
  }
  async read(owner: string, path: string) {
    const file = await this.info(owner, path);
    return this.storage.read(owner, file.storagePath!);
  }
  async write(owner: string, path: string, data: Buffer, options: Parameters<UserStorage['write']>[3] = {}) {
    const physical = this.physical(owner, path);
    if (options.expectedMtime) {
      const current = await this.info(owner, path);
      if (new Date(current.updatedAt).getTime() !== options.expectedMtime.getTime())
        throw new FileStorageError('文件已更新，请重新读取后修改', 409);
      if (current.storagePath !== physical) options = { ...options, expectedMtime: undefined, overwrite: false };
    }
    return this.project(await this.storage.write(owner, physical, data, options), this.logical(owner, path));
  }
  async remove(owner: string, path: string) {
    const current = await this.info(owner, path);
    // Linked uploads/legacy files are shared originals; editing creates a conversation copy.
    if (current.storagePath !== this.physical(owner, path)) throw new FileStorageError('请在文件管理中删除原始文件');
    await this.storage.remove(owner, current.storagePath);
  }
  async directories(owner: string) {
    if (!this.context.getStore()) return [];
    const { prefix } = this.scope(owner);
    return (await this.storage.directories(owner))
      .filter(path => path.startsWith(prefix + '/'))
      .map(path => path.slice(prefix.length));
  }
  async move(owner: string, from: string, to: string, overwrite = true) {
    const source = await this.info(owner, from);
    if (source.storagePath !== this.physical(owner, from)) throw new FileStorageError('请先复制原始文件再移动');
    return this.storage.move(owner, source.storagePath, this.physical(owner, to), overwrite);
  }
  async mkdir(owner: string, path: string) {
    return this.storage.mkdir(owner, this.physical(owner, path));
  }
  async rmdir(owner: string, path: string) {
    return this.storage.rmdir(owner, this.physical(owner, path));
  }
  processor(resolve: (context: RequestContext | undefined, thread: string | undefined) => Promise<FileScope>) {
    return {
      id: 'altflow-conversation-files',
      processInputStep: async args => {
        const scope = await resolve(args.requestContext, args.messageList.serialize().memoryInfo?.threadId);
        await this.storage.linkLegacyConversationFiles(scope.owner, scope.root);
        for (const message of args.messageList.get.all.db()) {
          if (message.role !== 'user') continue;
          for (const part of message.content.parts) {
            if (part.type !== 'text' || !/^<(?:attachment|workspace-attachment)[\s>]/.test(part.text)) continue;
            const path = part.text.match(/文件已保存到当前用户工作区：(\/uploads\/[^\n<]+)/)?.[1];
            if (path) await this.storage.linkConversationUpload(scope.owner, scope.root, path);
          }
        }
        const tools = { ...args.tools };
        for (const [name, tool] of Object.entries(tools)) {
          if (!tool || typeof tool !== 'object' || !('execute' in tool) || typeof tool.execute !== 'function') continue;
          const execute = tool.execute;
          tools[name] = {
            ...tool,
            execute: (...input: unknown[]) => this.run(scope, () => execute.apply(tool, input)),
          };
        }
        return { tools };
      },
    } satisfies Processor;
  }
}
