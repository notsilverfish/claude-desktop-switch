import fs from 'node:fs';
import path from 'node:path';
import { CdsError } from '../errors.js';
import { exists, readJsonOr, removePath, renamePath, writeJsonAtomic } from '../util/fs.js';
import { captureAuth, cryptoFingerprint, hasSavedAuth, type LiveAccount } from './auth.js';
import type { Home } from './home.js';

export interface Profile {
  id: string;
  name: string;
  accountUuid: string | null;
  createdAt: string;
  savedAt: string | null;
  appVersion: string | null;
  /** cryptoFingerprint() of the data folder when the login was saved. */
  cryptoKey: string | null;
  status: 'ok' | 'needs-login';
}

const META = 'profile.json';
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._@+-]{0,47}$/u;

export function validateName(name: string): string {
  const trimmed = name.trim();
  if (!NAME_RE.test(trimmed)) {
    throw new CdsError(
      `Invalid profile name "${name}".`,
      'Use 1-48 characters: letters, digits, spaces and . _ @ + - (starting with a letter or digit).',
    );
  }
  return trimmed;
}

export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'profile';
}

export const profileDir = (home: Home, id: string) => path.join(home.profiles, id);
export const authDir = (home: Home, id: string) => path.join(home.profiles, id, 'auth');

export function listProfiles(home: Home): Profile[] {
  if (!exists(home.profiles)) return [];
  return fs.readdirSync(home.profiles, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.includes('.cds-'))
    .map((e) => readJsonOr<Profile | null>(path.join(home.profiles, e.name, META), null))
    .filter((p): p is Profile => p !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Look up by name or id (case-insensitive), or by account id / its prefix.
export function findProfile(home: Home, query: string): Profile | undefined {
  const q = query.trim().toLowerCase();
  const all = listProfiles(home);
  return all.find((p) => p.name.toLowerCase() === q || p.id === q)
    ?? (q.length >= 8 ? all.find((p) => p.accountUuid?.toLowerCase().startsWith(q)) : undefined);
}

export function requireProfile(home: Home, query: string): Profile {
  const p = findProfile(home, query);
  if (!p) {
    const names = listProfiles(home).map((x) => x.name);
    throw new CdsError(`No profile named "${query}".`, names.length ? `Saved profiles: ${names.join(', ')}` : 'Save one first: claude-switch save <name>');
  }
  return p;
}

export function findByAccount(home: Home, uuid: string | null): Profile | undefined {
  if (!uuid) return undefined;
  return listProfiles(home).find((p) => p.accountUuid === uuid);
}

export function writeProfile(home: Home, profile: Profile): void {
  writeJsonAtomic(path.join(profileDir(home, profile.id), META), profile);
}

export function createProfile(home: Home, name: string, accountUuid: string | null): Profile {
  const clean = validateName(name);
  if (findProfile(home, clean)) throw new CdsError(`A profile named "${clean}" already exists.`);
  const base = slugify(clean);
  let id = base;
  for (let i = 2; exists(profileDir(home, id)); i++) id = `${base}-${i}`;
  const profile: Profile = {
    id,
    name: clean,
    accountUuid,
    createdAt: new Date().toISOString(),
    savedAt: null,
    appVersion: null,
    cryptoKey: null,
    status: 'ok',
  };
  writeProfile(home, profile);
  return profile;
}

// Save the live login into a profile and refresh its metadata.
export function saveLiveInto(home: Home, dataDir: string, profile: Profile, appVersion: string | null): LiveAccount {
  const account = captureAuth(dataDir, authDir(home, profile.id));
  Object.assign(profile, {
    accountUuid: account.uuid,
    savedAt: new Date().toISOString(),
    appVersion,
    cryptoKey: cryptoFingerprint(dataDir),
    status: 'ok',
  } satisfies Partial<Profile>);
  writeProfile(home, profile);
  return account;
}

export function renameProfile(home: Home, profile: Profile, newName: string): Profile {
  const clean = validateName(newName);
  const clash = findProfile(home, clean);
  if (clash && clash.id !== profile.id) throw new CdsError(`A profile named "${clean}" already exists.`);
  const newId = slugify(clean);
  if (newId !== profile.id && !exists(profileDir(home, newId))) {
    renamePath(profileDir(home, profile.id), profileDir(home, newId));
    profile.id = newId;
  }
  profile.name = clean;
  writeProfile(home, profile);
  return profile;
}

export function deleteProfile(home: Home, profile: Profile): void {
  removePath(profileDir(home, profile.id));
}

export function profileHasLogin(home: Home, profile: Profile): boolean {
  return hasSavedAuth(authDir(home, profile.id));
}
