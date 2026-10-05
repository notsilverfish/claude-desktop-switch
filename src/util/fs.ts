import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows briefly locks files (antivirus, indexer, a process that just exited).
// Retry those errors with backoff before giving up.
export function withRetry<T>(fn: () => T, attempts = 8): T {
  let delay = 50;
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (i >= attempts || !RETRY_CODES.has(code)) throw e;
      sleepSync(delay);
      delay = Math.min(delay * 2, 1000);
    }
  }
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(withRetry(() => fs.readFileSync(file, 'utf8')).replace(/^﻿/, '')) as T;
}

export function readJsonOr<T>(file: string, fallback: T): T {
  try {
    return readJson<T>(file);
  } catch {
    return fallback;
  }
}

// Write to a temp file next to the target, then rename over it, so a crash
// never leaves a half-written file.
export function writeFileAtomic(file: string, data: string | Buffer): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.cds-tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  withRetry(() => fs.renameSync(tmp, file));
}

export function writeJsonAtomic(file: string, value: unknown, indent: string | number = 2): void {
  writeFileAtomic(file, JSON.stringify(value, null, indent) + (indent ? '\n' : ''));
}

export function removePath(p: string): void {
  withRetry(() => fs.rmSync(p, { recursive: true, force: true }));
}

export function copyPath(src: string, dst: string): boolean {
  if (!fs.existsSync(src)) return false;
  ensureDir(path.dirname(dst));
  withRetry(() => fs.cpSync(src, dst, { recursive: true, force: true, errorOnExist: false }));
  return true;
}

export function renamePath(src: string, dst: string): void {
  withRetry(() => fs.renameSync(src, dst));
}

export function sha16(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

export function pathSize(p: string): number {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of fs.readdirSync(p)) total += pathSize(path.join(p, e));
  return total;
}

export function* walkFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full);
    else if (e.isFile()) yield full;
  }
}

// Same physical folder? (Store installs project one folder onto another path.)
export function samePath(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a, { bigint: true });
    const sb = fs.statSync(b, { bigint: true });
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  }
}

export function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function isGuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
