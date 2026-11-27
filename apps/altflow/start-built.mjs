import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelCredential } from './scripts/environment.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
/** @type {NodeJS.ProcessEnv} */
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
function run(command, args, extraEnv) {
  return new Promise((done, reject) => {
    current = spawn(command, args, { cwd: root, stdio: 'inherit', env: { ...env, ...extraEnv } });
    current.once('error', reject);
    current.once('exit', code => done(code ?? 1));
  });
}
// Use this checkout's workspace framework and integration packages.
// A fresh registry install in the output directory would replace those local builds.
const skipBuild = process.argv.includes('--skip-build');
if (!skipBuild) await rm(resolve(root, '.mastra/output/node_modules'), { recursive: true, force: true });
const built = skipBuild ? 0 : await run(resolve(root, 'node_modules/.bin/mastra'), ['build']);
if (built === 0 && !process.argv.includes('--build-only')) {
  if (env.ALTFLOW_BACKUP_PREFIX && env.ALTFLOW_BACKUP_CLEANUP === 'true') {
    const compacted = await run(process.execPath, ['--import', 'tsx', 'scripts/backup.mjs', 'compact', '--if-needed']);
    if (compacted !== 0) console.warn('[altflow backup] Trace compaction deferred');
  }
  process.exitCode = await run(process.execPath, ['.mastra/output/index.mjs'], { MASTRA_BACKUP_RUNTIME: 'true' });
} else {
  process.exitCode = built;
}
