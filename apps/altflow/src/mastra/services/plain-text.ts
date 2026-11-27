import { FileStorageError } from '../user-storage';

export const isPlainTextDocument = (path: string) =>
  /\.(txt|md|markdown|csv|tsv|json|yaml|yml|xml|html?|log)$/i.test(path);

export function decodePlainText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    if (!bytes.includes(0)) {
      try {
        return new TextDecoder('gb18030', { fatal: true }).decode(bytes);
      } catch {
        // Report unsupported or damaged text below.
      }
    }
    throw new FileStorageError('无法读取文本编码。支持 UTF-8、GBK 和 GB18030。');
  }
}
