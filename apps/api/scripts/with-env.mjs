#!/usr/bin/env node
// Runs a command with the repository-root .env loaded (Node's built-in parser, no dependency).
// Already-set environment variables win, so CI can override anything.
//   node scripts/with-env.mjs prisma migrate dev
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: with-env.mjs <command> [...args]');
  process.exit(2);
}
const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
