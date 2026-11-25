import { createHash } from 'node:crypto';

export const creatorFileId = (path: string, version: string) =>
  createHash('sha256')
    .update(JSON.stringify([path, version]))
    .digest('hex');
