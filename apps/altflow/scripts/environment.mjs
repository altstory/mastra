import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const local = parseEnv(
  await readFile(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  }),
);
for (const [name, value] of Object.entries(local)) {
  if (process.env[name] === undefined) process.env[name] = value;
}
export function modelCredential() {
  if (!process.env.ALTFLOW_MODELHUB_API_KEY) throw new Error('Set ALTFLOW_MODELHUB_API_KEY');
  return process.env.ALTFLOW_MODELHUB_API_KEY;
}
