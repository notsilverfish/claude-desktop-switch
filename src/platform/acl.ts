import { execFileSync } from 'node:child_process';
import { fakeMode } from './install.js';

// Limit a folder to the current user and SYSTEM (no inherited access for other
// users or Administrators group). Returns false if icacls failed.
export function restrictToCurrentUser(dir: string): boolean {
  if (fakeMode()) return true;
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!user) return false;
  try {
    execFileSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/Q'],
      { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// True if anyone other than the current user / SYSTEM / the owner has access.
export function isRestricted(dir: string): boolean | null {
  if (fakeMode()) return true;
  try {
    const raw = execFileSync('icacls.exe', [dir], { encoding: 'utf8', windowsHide: true });
    const user = (process.env.USERNAME ?? '').toLowerCase();
    // ACE lines look like "<path> DOMAIN\user:(OI)(CI)(F)"; the summary line is localized, so match the shape.
    const aces = raw.split(/\r?\n/).filter((l) => l.includes(':(')).map((l) => l.replace(dir, '').trim());
    return aces.every((a) => {
      const who = a.split(':')[0]!.toLowerCase();
      return who.endsWith(`\\${user}`) || who === user || who.includes('system') || who.includes('s-1-5-18');
    });
  } catch {
    return null;
  }
}
