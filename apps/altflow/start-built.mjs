import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelCredential } from './scripts/environment.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const env = {
  ...process.env,
  ALTFLOW_MODELHUB_API_KEY: await modelCredential(),
  ALTFLOW_RUNTIME_ROOT: resolve(process.env.ALTFLOW_RUNTIME_ROOT ?? process.env.MASTRA_PREVIEW_ROOT ?? root),
  MASTRA_BUILD_SKIP_INSTALL: 'true',
};
// Config discovery opens stores before the application's top-level setup runs.
await mkdir(resolve(env.ALTFLOW_RUNTIME_ROOT, 'src/mastra/public'), { recursive: true });
await mkdir(resolve(env.ALTFLOW_RUNTIME_ROOT, 'data'), { recursive: true });
let current;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => current?.kill(signal));
function run(command, args) {
  return new Promise((done, reject) => {
    current = spawn(command, args, { cwd: root, stdio: 'inherit', env });
    current.once('error', reject);
    current.once('exit', code => done(code ?? 1));
  });
}
// Use this checkout's workspace framework and integration packages.
// A fresh registry install in the output directory would replace those local builds.
const skipBuild = process.argv.includes('--skip-build');
if (!skipBuild) await rm(resolve(root, '.mastra/output/node_modules'), { recursive: true, force: true });
const built = skipBuild ? 0 : await run(resolve(root, 'node_modules/.bin/mastra'), ['build']);
process.exitCode =
  built === 0 && !process.argv.includes('--build-only')
    ? await run(process.execPath, ['.mastra/output/index.mjs'])
    : built;
