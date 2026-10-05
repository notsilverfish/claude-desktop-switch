import fs from 'node:fs';
import path from 'node:path';
import { restrictToCurrentUser } from '../platform/acl.js';
import { ensureDir } from '../util/fs.js';

// The tool's own storage. Holds saved logins, so it is locked to the current user.
export interface Home {
  root: string;
  profiles: string;
  backups: string;
  vault: string;
  logs: string;
  exports: string;
  journalFile: string;
  lockFile: string;
}

export function homePaths(override?: string): Home {
  const root = path.resolve(
    override ?? process.env.CDS_HOME ?? path.join(process.env.LOCALAPPDATA ?? '', 'claude-desktop-switch'),
  );
  return {
    root,
    profiles: path.join(root, 'profiles'),
    backups: path.join(root, 'backups'),
    vault: path.join(root, 'vault'),
    logs: path.join(root, 'logs'),
    exports: path.join(root, 'exports'),
    journalFile: path.join(root, 'journal.json'),
    lockFile: path.join(root, 'lock'),
  };
}

export function ensureHome(home: Home): Home {
  const fresh = !fs.existsSync(home.root);
  for (const dir of [home.root, home.profiles, home.backups, home.vault, home.logs]) ensureDir(dir);
  const marker = path.join(home.root, '.acl');
  if (fresh || !fs.existsSync(marker)) {
    if (restrictToCurrentUser(home.root)) fs.writeFileSync(marker, new Date().toISOString());
  }
  return home;
}
