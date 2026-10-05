import fs from 'node:fs';
import path from 'node:path';
import { CdsError } from '../errors.js';
import {
  copyPath, ensureDir, exists, pathSize, readJson, readJsonOr, removePath, renamePath, sha16, writeFileAtomic,
  writeJsonAtomic,
} from '../util/fs.js';

// What makes up a Claude Desktop login (confirmed in Phase 0: clearing these logs
// the app out, restoring them signs it back in):
//  - config.json keys: the OS-encrypted OAuth token caches and the active account id
//  - claude.ai cookies and web storage
// Token values are never decrypted or printed; files are copied as opaque blobs.
export const AUTH_PATHS = [
  'Network/Cookies',
  'Network/Cookies-journal',
  'Local Storage',
  'IndexedDB',
  'Session Storage',
  'WebStorage',
] as const;

export const isAuthKey = (key: string) => key.startsWith('oauth:') || key === 'lastKnownAccountUuid';

const AUTH_CONFIG = 'auth-config.json';
const FILES = 'files';

export type DesktopConfig = Record<string, unknown>;

export interface LiveAccount {
  uuid: string | null;
  hasTokens: boolean;
  /** Hash of the encrypted token blob, to notice refreshes without reading it. */
  tokenDigest: string | null;
}

export function configPath(dataDir: string): string {
  return path.join(dataDir, 'config.json');
}

export function readDesktopConfig(dataDir: string): DesktopConfig {
  const file = configPath(dataDir);
  if (!exists(file)) throw new CdsError(`No config.json in ${dataDir}.`, 'Open Claude Desktop once, or check --data-dir.');
  return readJson<DesktopConfig>(file);
}

// Desktop writes config.json tab-indented; keep that format.
export function writeDesktopConfig(dataDir: string, config: DesktopConfig): void {
  writeFileAtomic(configPath(dataDir), JSON.stringify(config, null, '\t'));
}

export function accountOf(config: DesktopConfig): LiveAccount {
  const uuid = typeof config.lastKnownAccountUuid === 'string' ? config.lastKnownAccountUuid : null;
  const token = config['oauth:tokenCacheV2'] ?? config['oauth:tokenCache'];
  const hasTokens = typeof token === 'string' && token.length > 0;
  return { uuid, hasTokens, tokenDigest: hasTokens ? sha16(String(token)) : null };
}

export function readLiveAccount(dataDir: string): LiveAccount {
  return accountOf(readDesktopConfig(dataDir));
}

export function readSavedAccount(authDir: string): LiveAccount {
  return accountOf(readJsonOr<DesktopConfig>(path.join(authDir, AUTH_CONFIG), {}));
}

export function hasSavedAuth(authDir: string): boolean {
  return exists(path.join(authDir, AUTH_CONFIG));
}

// Fingerprint of the key Windows uses to encrypt the tokens. It changes when
// Claude Desktop is reinstalled, which makes every saved login unusable.
export function cryptoFingerprint(dataDir: string): string | null {
  const state = readJsonOr<{ os_crypt?: { encrypted_key?: string } }>(path.join(dataDir, 'Local State'), {});
  const key = state.os_crypt?.encrypted_key;
  return key ? sha16(key) : null;
}

// Copy the live login into `dest` (replacing it). Written to a temp folder first,
// then swapped in, so `dest` is never left half-written.
export function captureAuth(dataDir: string, dest: string): LiveAccount {
  const config = readDesktopConfig(dataDir);
  const tmp = `${dest}.cds-tmp`;
  removePath(tmp);
  ensureDir(tmp);
  const authConfig = Object.fromEntries(Object.entries(config).filter(([k]) => isAuthKey(k)));
  writeJsonAtomic(path.join(tmp, AUTH_CONFIG), authConfig, 0);
  for (const rel of AUTH_PATHS) copyPath(path.join(dataDir, rel), path.join(tmp, FILES, rel));
  const old = `${dest}.cds-old`;
  removePath(old);
  if (exists(dest)) renamePath(dest, old);
  renamePath(tmp, dest);
  removePath(old);
  return accountOf(config);
}

// Leftovers from an interrupted apply.
export function cleanStaging(dataDir: string): number {
  let removed = 0;
  for (const rel of AUTH_PATHS) {
    for (const suffix of ['.cds-new', '.cds-old']) {
      const p = path.join(dataDir, rel + suffix);
      if (exists(p)) {
        removePath(p);
        removed++;
      }
    }
  }
  return removed;
}

// Replace the live login with the one saved in `srcDir`, or remove it entirely
// when `srcDir` is null (the app then shows its sign-in screen). Only the login
// parts change; every other setting and file in the data folder is kept.
// Callers must back up first and hold a journal entry: see switcher.ts.
export function applyAuth(dataDir: string, srcDir: string | null): void {
  if (srcDir && !hasSavedAuth(srcDir)) throw new CdsError(`Saved login is incomplete: ${srcDir}`);
  readDesktopConfig(dataDir); // fail early if the data folder is wrong
  cleanStaging(dataDir);

  // 1. Stage new copies next to the live ones.
  for (const rel of AUTH_PATHS) {
    if (srcDir) copyPath(path.join(srcDir, FILES, rel), path.join(dataDir, rel + '.cds-new'));
  }
  // 2. Swap: live -> .cds-old, staged -> live.
  for (const rel of AUTH_PATHS) {
    const live = path.join(dataDir, rel);
    if (exists(live)) renamePath(live, live + '.cds-old');
    if (exists(live + '.cds-new')) renamePath(live + '.cds-new', live);
  }
  if (process.env.CDS_TEST_FAIL_AFTER_FILES === '1') throw new Error('test: simulated crash after files');

  // 3. config.json last: it names the active account, so it acts as the commit.
  const config = readDesktopConfig(dataDir);
  for (const key of Object.keys(config)) if (isAuthKey(key)) delete config[key];
  if (srcDir) Object.assign(config, readJson<DesktopConfig>(path.join(srcDir, AUTH_CONFIG)));
  writeDesktopConfig(dataDir, config);

  cleanStaging(dataDir);
}

export function authSize(authDir: string): number {
  return pathSize(authDir);
}

export function listAuthFiles(authDir: string): string[] {
  return AUTH_PATHS.filter((rel) => fs.existsSync(path.join(authDir, FILES, rel)));
}
