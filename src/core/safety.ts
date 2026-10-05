import fs from 'node:fs';
import path from 'node:path';
import { CdsError } from '../errors.js';
import { ensureDir, readJsonOr, removePath, timestamp, writeJsonAtomic } from '../util/fs.js';
import { captureAuth, readSavedAccount } from './auth.js';
import type { Home } from './home.js';

// ---------------------------------------------------------------- lock
// One claude-desktop-switch operation at a time.

interface LockInfo {
  pid: number;
  op: string;
  at: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireLock(home: Home, op: string): () => void {
  const info: LockInfo = { pid: process.pid, op, at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(home.lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify(info));
      fs.closeSync(fd);
      return () => {
        const cur = readJsonOr<LockInfo | null>(home.lockFile, null);
        if (cur?.pid === process.pid) removePath(home.lockFile);
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const cur = readJsonOr<LockInfo | null>(home.lockFile, null);
      const stale = !cur || !pidAlive(cur.pid) || Date.now() - Date.parse(cur.at) > 30 * 60_000;
      if (!stale) {
        throw new CdsError(`Another claude-desktop-switch operation is running ("${cur!.op}", pid ${cur!.pid}).`,
          'Wait for it to finish. If it crashed, run: claude-switch repair');
      }
      removePath(home.lockFile);
    }
  }
  throw new CdsError('Could not acquire the lock.', 'Run: claude-switch repair');
}

export function readLock(home: Home): (LockInfo & { stale: boolean }) | null {
  const cur = readJsonOr<LockInfo | null>(home.lockFile, null);
  if (!cur) return null;
  return { ...cur, stale: !pidAlive(cur.pid) };
}

// ---------------------------------------------------------------- journal
// Written before the live login is touched and removed after it is consistent
// again. If one is left behind, the operation was interrupted: `repair` restores
// the backup it points to.

export interface Journal {
  op: string;
  startedAt: string;
  backupDir: string;
  target?: string;
}

export function writeJournal(home: Home, journal: Omit<Journal, 'startedAt'>): void {
  writeJsonAtomic(home.journalFile, { ...journal, startedAt: new Date().toISOString() });
}

export function readJournal(home: Home): Journal | null {
  return readJsonOr<Journal | null>(home.journalFile, null);
}

export function clearJournal(home: Home): void {
  removePath(home.journalFile);
}

// ---------------------------------------------------------------- backups
// A copy of the live login before every change. Kept in the (user-only) tool home.

const KEEP_BACKUPS = 20;

export interface BackupInfo {
  dir: string;
  name: string;
  reason: string;
  accountUuid: string | null;
}

export function backupLiveAuth(home: Home, dataDir: string, reason: string): string {
  ensureDir(home.backups);
  let dir = path.join(home.backups, `${timestamp()}-${reason}`);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(home.backups, `${timestamp()}-${reason}-${i}`);
  captureAuth(dataDir, dir);
  pruneBackups(home);
  return dir;
}

export function listBackups(home: Home): BackupInfo[] {
  if (!fs.existsSync(home.backups)) return [];
  return fs.readdirSync(home.backups, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{8}-\d{6}-/.test(e.name) && !e.name.includes('.cds-'))
    .map((e) => ({
      dir: path.join(home.backups, e.name),
      name: e.name,
      reason: e.name.slice(16),
      accountUuid: readSavedAccount(path.join(home.backups, e.name)).uuid,
    }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

function pruneBackups(home: Home): void {
  const journal = readJournal(home);
  for (const b of listBackups(home).slice(KEEP_BACKUPS)) {
    if (journal && path.resolve(journal.backupDir) === path.resolve(b.dir)) continue;
    removePath(b.dir);
  }
}
