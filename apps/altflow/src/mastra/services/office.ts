import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { createConverter } from '@deepseek-ai/libreoffice-kit';
import { FileStorageError } from '../user-storage';
import type { UserStorage } from '../user-storage';

export const isOfficeDocument = (path: string) => /\.(docx?|odt|xlsx?|ods|pptx?|odp|pdf)$/i.test(path);

const mimeTypes: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
};
const officeMimeType = (extension: string) => mimeTypes[extension] ?? 'application/octet-stream';

function officeConverter() {
  return createConverter({
    timeoutMs: 60_000,
    maxInputBytes: 50 * 1024 * 1024,
    maxOutputBytes: 100 * 1024 * 1024,
    maxImageResolution: 192,
    maxArchiveEntries: 10_000,
    maxUncompressedBytes: 250 * 1024 * 1024,
  });
}

/** Uses DSH's office-kit engine and private-snapshot lifecycle, with its deployment limits.
 * Reference: deepseek-harness/packages/document/office-kit/src/index.ts, runOperation.
 * Storage authorization happens before any native conversion; originals are never changed.
 */
export class OfficeReader {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly storage: Pick<UserStorage, 'info' | 'read' | 'write' | 'remove'>) {}

  async read(owner: string, path: string, signal?: AbortSignal): Promise<string> {
    return this.withSnapshot(owner, path, signal, async ({ inputPath, extension, directory, bytes }) => {
      // Writer's text export preserves full flowing text without PDF pagination loss.
      const writer = /\.(docx?|odt)$/.test(extension);
      const outputPath = join(directory, writer ? 'body.txt' : 'body.pdf');
      if (extension !== '.pdf') {
        const converter = await officeConverter();
        try {
          await converter.convert({ inputPath, outputPath }, signal);
        } finally {
          await converter.dispose();
        }
      }
      if (writer) return (await readFile(outputPath, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const loading = getDocument({
        data: new Uint8Array(extension === '.pdf' ? bytes : await readFile(outputPath)),
        useSystemFonts: true,
        isEvalSupported: false,
      });
      const abort = () => {
        void loading.destroy();
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        const pdf = await loading.promise;
        const pages: string[] = [];
        for (let page = 1; page <= pdf.numPages; page++) {
          signal?.throwIfAborted();
          const content = await (await pdf.getPage(page)).getTextContent();
          pages.push(content.items.map(item => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '')).join(''));
        }
        const text = pages.join('\n\n');
        if (!text.trim())
          throw new FileStorageError('文档没有可提取的文字。扫描件需要 OCR，不能把空正文当成读取成功。');
        return text;
      } finally {
        signal?.removeEventListener('abort', abort);
        await loading.destroy();
      }
    });
  }

  async produce(
    owner: string,
    path: string,
    operation: 'convert' | 'render' | 'recalculate',
    options: { format?: string; pages?: number[]; sheet?: string; range?: string; dpi?: number },
    signal?: AbortSignal,
  ) {
    return this.withSnapshot(owner, path, signal, async ({ inputPath, directory, name, extension }) => {
      const converter = await officeConverter();
      const outputRoot = '/outputs/office/' + randomUUID();
      const stem = name.slice(0, -extension.length).slice(0, 160);
      const pending: { local: string; path: string }[] = [];
      const written: string[] = [];
      try {
        if (operation === 'render') {
          const result = await converter.renderImages(
            {
              inputPath,
              outputDir: join(directory, 'pages'),
              pages: options.pages,
              sheet: options.sheet,
              range: options.range,
              dpi: options.dpi ?? 120,
              maxPages: 8,
              maxPixels: 4_000_000,
              maxDimension: 4096,
            },
            signal,
          );
          for (const image of result.images) {
            pending.push({ local: image.path, path: outputRoot + '/' + stem + '-' + image.index + '.png' });
          }
        } else {
          const format = options.format ?? (operation === 'recalculate' && extension === '.ods' ? 'ods' : 'xlsx');
          const outputPath = join(directory, 'result.' + format);
          if (operation === 'recalculate') await converter.recalculate({ inputPath, outputPath }, signal);
          else await converter.convert({ inputPath, outputPath, sheet: options.sheet }, signal);
          pending.push({
            local: outputPath,
            path: outputRoot + '/' + stem + (operation === 'recalculate' ? '-recalculated' : '') + '.' + format,
          });
        }
        const files = [];
        for (const file of pending) {
          signal?.throwIfAborted();
          const stored = await this.storage.write(owner, file.path, await readFile(file.local), {
            overwrite: false,
            mimeType: officeMimeType(extname(file.path)),
          });
          written.push(stored.path);
          files.push(stored);
        }
        return { files };
      } catch (error) {
        await Promise.allSettled(written.map(path => this.storage.remove(owner, path)));
        throw error;
      } finally {
        await converter.dispose();
      }
    });
  }

  private async withSnapshot<T>(
    owner: string,
    path: string,
    signal: AbortSignal | undefined,
    run: (snapshot: {
      inputPath: string;
      extension: string;
      directory: string;
      bytes: Buffer;
      name: string;
    }) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (!isOfficeDocument(path)) throw new FileStorageError('不支持的文档格式');
    const info = await this.storage.info(owner, path);
    if (info.size > 50 * 1024 * 1024) throw new FileStorageError('Office 文档超过 50 MB 读取上限', 413);
    await this.acquire(signal);
    let directory: string | undefined;
    try {
      const bytes = await this.storage.read(owner, path);
      signal?.throwIfAborted();
      if (bytes.length > 50 * 1024 * 1024) throw new FileStorageError('Office 文档超过 50 MB 读取上限', 413);
      directory = await mkdtemp(join(tmpdir(), 'altflow-office-kit-'));
      const extension = extname(info.name).toLowerCase();
      const inputPath = join(directory, `source${extension}`);
      await writeFile(inputPath, bytes, { flag: 'wx', mode: 0o600, signal });
      return await run({ inputPath, extension, directory, bytes, name: info.name });
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        const next = this.queue.shift();
        if (next) next();
        else this.active--;
      }
    }
  }

  private async acquire(signal?: AbortSignal) {
    if (this.active < 2) {
      this.active++;
      return;
    }
    if (this.queue.length >= 8) throw new FileStorageError('Office 解析队列已满，请稍后重试', 503);
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        const index = this.queue.indexOf(ready);
        if (index !== -1) this.queue.splice(index, 1);
        reject(signal?.reason);
      };
      this.queue.push(ready);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}
