import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import type { StorageSummary } from '@/domains/account/storage-api';

export const filesFixture: StorageSummary = {
  quotaBytes: 536870912,
  usedBytes: 64,
  reservedBytes: 0,
  files: [
    {
      path: '/uploads/a/notes.txt',
      name: 'notes.txt',
      size: 16,
      mimeType: 'text/plain',
      source: 'upload',
      updatedAt: '2026-11-18T01:00:00Z',
    },
    {
      path: '/outputs/draft.md',
      name: 'draft.md',
      size: 32,
      mimeType: 'text/markdown',
      source: 'generated',
      updatedAt: '2026-11-18T02:00:00Z',
    },
    {
      path: '/outputs/cover.png',
      name: 'cover.png',
      size: 16,
      mimeType: 'image/png',
      source: 'generated',
      updatedAt: '2026-11-18T02:01:00Z',
    },
  ],
};

export const scopedFilesFixture: StorageSummary = {
  ...filesFixture,
  files: [{ ...filesFixture.files[1], storagePath: '/conversations/current/outputs/draft.md' }],
};

export const fileMessages: MastraDBMessage[] = [
  {
    id: 'upload',
    role: 'user',
    createdAt: new Date('2026-11-18'),
    content: {
      format: 2,
      parts: [
        {
          type: 'text',
          text: '<attachment name="notes.txt">文件已保存到当前用户工作区：/uploads/a/notes.txt\n下载地址：http://localhost:4111/storage/download?path=%2Fuploads%2Fa%2Fnotes.txt</attachment>',
        },
      ],
    },
  },
  {
    id: 'generated',
    role: 'assistant',
    createdAt: new Date('2026-11-18'),
    content: {
      format: 2,
      parts: [
        {
          type: 'tool-invocation',
          toolInvocation: {
            toolCallId: 'write-1',
            toolName: 'mastra_workspace_write_file',
            state: 'result',
            args: { path: '/outputs/draft.md', content: '# Draft' },
            result: { success: true },
          },
        },
      ],
    },
  },
  {
    id: 'image',
    role: 'assistant',
    createdAt: new Date('2026-11-18'),
    content: {
      format: 2,
      parts: [{ type: 'text', text: '[Cover](http://localhost:4111/storage/download?path=%2Foutputs%2Fcover.png)' }],
    },
  },
];
