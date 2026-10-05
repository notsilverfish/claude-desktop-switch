import path from 'node:path';
import { c as pc } from '../util/output.js';
import type { Context } from '../context.js';
import { cryptoFingerprint, readLiveAccount } from '../core/auth.js';
import { findByAccount, listProfiles } from '../core/profiles.js';
import { readJournal, readLock } from '../core/safety.js';
import { isRestricted } from '../platform/acl.js';
import { dataDirCandidates, detectInstall, resolveDataDir } from '../platform/install.js';
import { claudeProcesses, liveUserDataDir } from '../platform/processes.js';
import { exists, samePath } from '../util/fs.js';
import { out, printJson, say } from '../util/output.js';
import { shortId } from './common.js';

// Desktop versions the file layout has been verified against.
export const TESTED_VERSIONS = ['2.19675'];

type Level = 'ok' | 'warn' | 'error' | 'info';
interface Check {
  name: string;
  level: Level;
  detail: string;
  hint?: string;
}

export async function doctorCommand(ctx: Context): Promise<number> {
  const checks: Check[] = [];
  const add = (name: string, level: Level, detail: string, hint?: string) => checks.push({ name, level, detail, hint });

  add('Node.js', Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : 'error', process.versions.node,
    'Needs Node.js 20 or newer.');
  if (process.platform !== 'win32') add('Platform', 'error', process.platform, 'Only Windows is supported for now.');

  const install = detectInstall();
  if (!install) {
    add('Claude Desktop', 'error', 'not installed', 'Install it from https://claude.ai/download');
  } else {
    const kind = { store: 'Microsoft Store', installer: 'installer', fake: 'test' }[install.kind];
    add('Claude Desktop', 'ok', `${kind} ${install.version ?? '(unknown version)'}`);
    const tested = TESTED_VERSIONS.some((v) => install.version?.startsWith(v));
    if (!tested && install.kind !== 'fake') {
      add('Tested version', 'warn', `${install.version} has not been tested yet`,
        'Switching should still work. If it does not, run "claude-switch repair" and report the version.');
    }
  }

  let dataDir: string | null = null;
  try {
    const data = resolveDataDir(ctx.opts.dataDir);
    dataDir = data.dir;
    add('Data folder', 'ok', data.dir + (data.source === 'store' ? pc.dim(' (Store package folder)') : ''));
    const appdata = dataDirCandidates(ctx.opts.dataDir).find((c) => c.source === 'appdata');
    if (data.source === 'store' && appdata) {
      add('Store projection', 'info', `${appdata.dir} mirrors the folder above only while Claude runs; the tool always uses the package folder.`);
    }
  } catch (e) {
    add('Data folder', 'error', (e as Error).message, 'Open Claude Desktop and sign in once.');
  }

  if (install && dataDir) {
    const procs = claudeProcesses(install);
    const sessions = procs.filter((p) => p.kind === 'code-session').length;
    add('Running', 'info', procs.length ? `yes (${procs.length} processes, ${sessions} Code session${sessions === 1 ? '' : 's'})` : 'no');
    if (procs.length) {
      const live = liveUserDataDir(install);
      if (live && !samePath(live, dataDir)) {
        add('Live data folder', 'error', `The running app uses ${live}`, 'Pass --data-dir with that folder and report this setup.');
      }
    }

    try {
      const account = readLiveAccount(dataDir);
      const profile = findByAccount(ctx.home, account.uuid);
      if (!account.uuid || !account.hasTokens) add('Signed in', 'info', 'no');
      else add('Signed in', profile ? 'ok' : 'warn', profile ? `"${profile.name}" (${shortId(account.uuid)})` : `account ${shortId(account.uuid)}, not saved`,
        profile ? undefined : 'Save it with: claude-switch save <name>');
    } catch (e) {
      add('Signed in', 'error', (e as Error).message);
    }

    const fp = cryptoFingerprint(dataDir);
    const profiles = listProfiles(ctx.home);
    const stale = profiles.filter((p) => p.cryptoKey && fp && p.cryptoKey !== fp);
    add('Profiles', stale.length ? 'warn' : 'ok', `${profiles.length} saved` + (stale.length ? `; ${stale.length} unusable after a reinstall: ${stale.map((p) => p.name).join(', ')}` : ''),
      stale.length ? 'Sign in to each again with: claude-switch add <name>' : undefined);
    const needLogin = profiles.filter((p) => p.status === 'needs-login');
    if (needLogin.length) {
      add('Needs sign-in', 'warn', needLogin.map((p) => p.name).join(', '), 'Refresh with: claude-switch add <name>');
    }
    const staging = ['Local Storage', 'IndexedDB', 'Network/Cookies'].flatMap((r) => ['.cds-new', '.cds-old'].map((s) => r + s))
      .filter((r) => exists(path.join(dataDir!, r)));
    if (staging.length) add('Leftover files', 'warn', staging.join(', '), 'Run: claude-switch repair');
  }

  const home = ctx.home;
  const restricted = isRestricted(home.root);
  add('Tool folder', restricted === false ? 'warn' : 'ok', home.root + (restricted ? pc.dim(' (only you can read it)') : ''),
    restricted === false ? 'Other users can read saved logins here. Delete the folder\'s .acl file and run any command to fix it.' : undefined);

  const journal = readJournal(home);
  if (journal) add('Interrupted operation', 'error', `"${journal.op}" started ${journal.startedAt} did not finish`, 'Run: claude-switch repair');
  const lock = readLock(home);
  if (lock) add('Lock', lock.stale ? 'warn' : 'info', `${lock.op} (pid ${lock.pid})${lock.stale ? ', stale' : ', running'}`,
    lock.stale ? 'Run: claude-switch repair' : undefined);

  const errors = checks.filter((c) => c.level === 'error').length;
  if (out.json) {
    printJson({ ok: errors === 0, checks });
  } else {
    // Aligned like amber's status: icon, label column, detail.
    const icon = { ok: pc.green('✓'), warn: pc.yellow('!'), error: pc.red('✗'), info: pc.dim('·') };
    const width = Math.max(...checks.map((ch) => ch.name.length));
    for (const ch of checks) {
      say(`  ${icon[ch.level]} ${ch.name.padEnd(width)}   ${ch.detail}`);
      if (ch.hint && ch.level !== 'ok') say(`    ${' '.repeat(width + 2)}${pc.dim(ch.hint)}`);
    }
    say();
    say(errors ? `  ${pc.red(`${errors} problem${errors > 1 ? 's' : ''} found.`)}` : `  ${pc.green('All good.')}`);
  }
  return errors ? 1 : 0;
}
