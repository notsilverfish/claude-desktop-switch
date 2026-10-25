import { spawnSync } from 'node:child_process';
import { CdsError } from '../errors.js';

// claude-switch stores backups with amber (npm: amber-backup): encrypted on this computer,
// deduplicated in the cloud, and a new computer signs in with a passkey. We run the
// installed `amber` command, so its sign-in, keys and progress output stay amber's own.
//
// CDS_AMBER_BIN points at a script to run with node instead (tests use a fake amber).

export interface AmberResult {
  ok: boolean;
  code: number;
  out: string;
}

// `amber list` grows with every snapshot; don't cut it off.
const MAX_OUTPUT = 64 * 1024 * 1024;

const quote = (a: string) => (/^[\w./:\\=@-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);

function run(args: string[], inherit: boolean): AmberResult {
  const fake = process.env.CDS_AMBER_BIN;
  const r = fake
    ? spawnSync(process.execPath, [fake, ...args], { encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', env: process.env, maxBuffer: MAX_OUTPUT })
    : spawnSync(['amber', ...args].map(quote).join(' '), { shell: true, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', windowsHide: true, maxBuffer: MAX_OUTPUT });
  if (r.error) return { ok: false, code: -1, out: r.error.message };
  return { ok: r.status === 0, code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** amber's version, or null if it isn't installed. */
export function amberVersion(): string | null {
  const r = run(['--version'], false);
  const v = r.out.trim().split(/\s+/).pop() ?? '';
  return r.ok && /^\d+\.\d+/.test(v) ? v : null;
}

export function requireAmber(): string {
  const v = amberVersion();
  if (!v) {
    throw new CdsError(
      'Backups are stored with amber, which is not installed.',
      'Install it with "npm install -g amber-backup", then sign in once with "amber login".',
    );
  }
  return v;
}

/** Runs amber with its own output shown live. Throws with a readable message if it fails. */
export function amber(args: string[], what: string): void {
  const r = run(args, true);
  if (!r.ok) {
    throw new CdsError(`amber could not ${what} (exit code ${r.code}).`, 'Its message is above. If it says you are not signed in, run "amber login".');
  }
}

/** Runs amber quietly and returns its output (for `list`). */
export function amberQuiet(args: string[]): AmberResult {
  return run(args, false);
}
