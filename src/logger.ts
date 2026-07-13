import { appendFileSync, mkdirSync } from 'node:fs';

let dirReady = false;

export function log(level: 'info' | 'warn' | 'error', msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  console.log(line);
  try {
    if (!dirReady) { mkdirSync('logs', { recursive: true }); dirReady = true; }
    appendFileSync('logs/bot.log', line + '\n');
  } catch {
    // console output already happened; never crash on log I/O
  }
}
