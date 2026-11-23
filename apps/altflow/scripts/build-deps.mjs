import { execFileSync, spawn } from 'node:child_process';
import { platform } from 'node:os';

const SWAP_LIMIT_MB = 3072;
const force = process.argv.includes('--force');

function swapUsedMb() {
  if (platform() !== 'darwin') return 0;
  const match = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).match(/used = ([\d.]+)M/);
  return match ? Number(match[1]) : 0;
}

const swap = swapUsedMb();
if (swap > SWAP_LIMIT_MB && !force) {
  console.error(`Swap in use is ${Math.round(swap)} MB (limit ${SWAP_LIMIT_MB} MB). Close large apps or pass --force.`);
  process.exit(1);
}

const child = spawn(
  'pnpm',
  ['exec', 'turbo', 'build', '--filter', './apps/altflow^...', '--filter', '!@mastra/playground-ui', '--concurrency=2'],
  { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=2048' } },
);
child.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', code => {
  process.exitCode = code ?? 1;
});
