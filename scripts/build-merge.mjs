#!/usr/bin/env node
// Merge-build helper: builds agentpay/frontend into portfolio/public/agentpay.
// Run portfolio's own build FIRST (it wipes public/), then the x402market and
// agentpay merges, then deploy the Pages project.
import { execSync } from 'node:child_process';
import { cpSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = join(root, 'frontend');
const out = join('/Users/rah/entangleit/portfolio', 'public', 'agentpay');
const dist = join(frontend, 'dist');

console.log('Building agentpay frontend...');
execSync('npm install --no-audit --no-fund', { cwd: frontend, stdio: 'inherit' });
execSync('npm run build', { cwd: frontend, stdio: 'inherit' });
if (!existsSync(dist)) throw new Error(`dist missing: ${dist}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(dist, out, { recursive: true });
console.log(`Merged -> ${out} (index: ${existsSync(join(out, 'index.html'))})`);
