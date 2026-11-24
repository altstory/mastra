import { t } from '@mastra/playground-ui/lib/i18n';
import { z } from 'zod';
import type { StudioConfig } from '@/domains/configuration/types';

export const storedFileSchema = z.object({
  path: z.string(),
  storagePath: z.string().optional(),
  name: z.string(),
  size: z.number().nonnegative(),
  mimeType: z.string(),
  source: z.enum(['upload', 'generated']),
  updatedAt: z.string(),
});
const storageSchema = z.object({
  quotaBytes: z.number().positive(),
  usedBytes: z.number().nonnegative(),
  reservedBytes: z.number().nonnegative(),
  files: z.array(storedFileSchema),
});
export type StoredFile = z.infer<typeof storedFileSchema>;
export type StorageSummary = z.infer<typeof storageSchema>;
type Target = Pick<StudioConfig, 'baseUrl' | 'headers'>;
export function storageUrl(target: Target, action = '', params?: Record<string, string>) {
  const url = new URL(`${target.baseUrl.replace(/\/$/, '')}/storage${action}`);
  if (params) url.search = new URLSearchParams(params).toString();
  return url.href;
}
async function storageRequest(target: Target, action: string, init?: RequestInit, params?: Record<string, string>) {
  const response = await fetch(storageUrl(target, action, params), {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
    headers: { ...target.headers, ...init?.headers },
  });
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(await response.json().catch(() => undefined));
    throw new Error(error.success ? error.data.error : t('File storage is unavailable. Please retry.'));
  }
  return response;
}
export async function getStorage(target: Target, thread?: string) {
  return storageSchema.parse(
    await (await storageRequest(target, '', undefined, thread ? { thread } : undefined)).json(),
  );
}
export async function uploadStoredFile(target: Target, file: File, id: string, contentType: string) {
  return storedFileSchema.parse(
    await (
      await storageRequest(
        target,
        '/upload',
        {
          method: 'POST',
          body: file,
          headers: { 'Content-Type': contentType },
        },
        { id, name: file.name },
      )
    ).json(),
  );
}
export async function deleteStoredFile(target: Target, path: string) {
  await storageRequest(target, '/file', { method: 'DELETE' }, { path });
}
export async function downloadStoredFile(target: Target, file: StoredFile) {
  const response = await storageRequest(target, '/download', undefined, { path: file.storagePath ?? file.path });
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Bound previews even if the file grows after listing. Downloads remain unrestricted. */
export const FILE_PREVIEW_LIMIT = 10 * 1024 * 1024;
export async function readStoredFile(target: Target, file: StoredFile, signal?: AbortSignal) {
  const tooLarge = () => new Error(t('This file is too large to preview. Download it to view.'));
  if (file.size > FILE_PREVIEW_LIMIT) throw tooLarge();
  const response = await storageRequest(target, '/download', { signal }, { path: file.storagePath ?? file.path });
  if (Number(response.headers.get('Content-Length')) > FILE_PREVIEW_LIMIT) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(t('File storage is unavailable. Please retry.'));
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FILE_PREVIEW_LIMIT) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: file.mimeType });
}

export const storedFileReferenceSchema = storedFileSchema.pick({ path: true, name: true });
export type StoredFileReference = z.infer<typeof storedFileReferenceSchema>;

const fileChangeSchema = z.object({
  turn: z.string(),
  path: z.string(),
  name: z.string(),
  kind: z.enum(['added', 'modified', 'deleted']),
  hasDiff: z.boolean(),
});

export async function getTurnFileChanges(target: Target, thread: string, signal?: AbortSignal) {
  const response = await storageRequest(target, '/changes', { signal }, { thread });
  return z.array(fileChangeSchema).parse(await response.json());
}

export async function getTurnFileDiff(
  target: Target,
  thread: string,
  turn: string,
  path: string,
  signal?: AbortSignal,
) {
  const response = await storageRequest(target, '/changes', { signal }, { thread, turn, path });
  return z.object({ before: z.string().nullable(), after: z.string().nullable() }).parse(await response.json());
}
