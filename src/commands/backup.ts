import path from 'node:path';
import type { Context } from '../context.js';
import {
  accountsWithPending, applyPending, applySelection, checkProjectName, hasSidebar, listChats, loadSettings, parseMaps,
  restoreFromFolder, restoreWorkDir, saveSettings, stageBackup, type Chat, type Selection,
} from '../core/backup.js';
import { findByAccount, findProfile, listProfiles, profileHasLogin } from '../core/profiles.js';
import { addAccount, ensureClosed } from '../core/switcher.js';
import { CdsError } from '../errors.js';
import { amber, amberQuiet, requireAmber } from '../platform/amber.js';
import { isAppRunning, launchApp, startedByClaude } from '../platform/processes.js';
import { c, confirm, done, info, ok, out, printJson, prompt, say, table, warn, withTask } from '../util/output.js';
import { relativeTime, runOutsideDesktopIfNeeded, shortId } from './common.js';

const accountName = (ctx: Context, id: string) => findByAccount(ctx.home, id)?.name ?? `(unsaved ${shortId(id)})`;
const when = (ms: number) => (ms ? relativeTime(new Date(ms).toISOString()) : 'never');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`);

// "1,3-5" → [0,2,3,4]. "all" or "" → null (meaning: no limit). Throws on nonsense.
export function parseNumbers(input: string, max: number): number[] | null {
  const s = input.trim().toLowerCase();
  if (!s || s === 'all') return null;
  const picked = new Set<number>();
  for (const part of s.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a number or a range like 2-5`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > max || a > b) throw new Error(`${part} is outside 1-${max}`);
    for (let i = a; i <= b; i++) picked.add(i - 1);
  }
  return [...picked].sort((x, y) => x - y);
}

async function askNumbers(question: string, max: number): Promise<number[] | null> {
  for (;;) {
    try {
      return parseNumbers(await prompt(question), max);
    } catch (e) {
      warn((e as Error).message);
    }
  }
}

// Step by step: accounts, then folders, then chats to leave out.
async function pickSelection(ctx: Context): Promise<Selection> {
  const all = listChats(ctx.dataDir);
  if (!all.length) throw new CdsError('There are no Code-tab chats on this PC to back up.');

  const accountIds = [...new Set(all.flatMap((ch) => ch.accounts))];
  say(c.bold('\n  Which accounts?'));
  accountIds.forEach((id, i) => say(`  ${c.accent(String(i + 1).padStart(2))}  ${accountName(ctx, id)}  ${c.dim(plural(all.filter((ch) => ch.accounts.includes(id)).length, 'chat'))}`));
  const pickedAccounts = await askNumbers(`Accounts to include ${c.dim('(e.g. 1,3; Enter = all)')}`, accountIds.length);
  const accounts = pickedAccounts?.map((i) => accountIds[i]!);
  let pool = applySelection(all, { accounts });

  const folders = [...new Map(pool.map((ch) => [ch.cwd.toLowerCase(), ch.cwd])).values()]
    .map((cwd) => ({ cwd, chats: pool.filter((ch) => ch.cwd.toLowerCase() === cwd.toLowerCase()) }))
    .sort((a, b) => b.chats.length - a.chats.length);
  say(c.bold('\n  Which folders?'));
  folders.forEach((f, i) => say(`  ${c.accent(String(i + 1).padStart(2))}  ${f.cwd || '(no folder)'}  ${c.dim(plural(f.chats.length, 'chat'))}`));
  const pickedFolders = await askNumbers(`Folders to include ${c.dim('(Enter = all)')}`, folders.length);
  const folderList = pickedFolders?.map((i) => folders[i]!.cwd).filter(Boolean);
  pool = applySelection(pool, { folders: folderList });

  say(c.bold(`\n  ${plural(pool.length, 'chat')} so far`));
  pool.forEach((ch, i) => say(`  ${c.accent(String(i + 1).padStart(2))}  ${ch.title.slice(0, 60)}  ${c.dim(`${path.basename(ch.cwd)} · ${when(ch.lastActivityAt)} · ${size(ch.bytes)}`)}`));
  const left = await askNumbers(`Chats to leave out ${c.dim('(e.g. 2,5-7; Enter = none)')}`, pool.length);
  const exclude = left?.map((i) => pool[i]!.sessionId);

  return { ...(accounts ? { accounts } : {}), ...(folderList?.length ? { folders: folderList } : {}), ...(exclude?.length ? { exclude } : {}) };
}

function describe(ctx: Context, sel: Selection): string {
  const parts: string[] = [];
  parts.push(sel.accounts?.length ? sel.accounts.map((a) => accountName(ctx, a)).join(', ') : 'all accounts');
  if (sel.folders?.length) parts.push(`in ${plural(sel.folders.length, 'folder')}`);
  if (sel.since) parts.push(`active in the last ${sel.since}`);
  if (sel.exclude?.length) parts.push(`${sel.exclude.length} left out`);
  return parts.join(', ');
}

function accountIdsFor(ctx: Context, names: string[]): string[] {
  return names.map((n) => {
    const p = findProfile(ctx.home, n);
    if (p?.accountUuid) return p.accountUuid;
    throw new CdsError(`No profile named "${n}".`, `Saved profiles: ${listProfiles(ctx.home).map((x) => x.name).join(', ') || 'none'}`);
  });
}

export interface BackupFlags {
  pick?: boolean;
  all?: boolean;
  accounts?: string[];
  folders?: string[];
  since?: string;
  name?: string;
  config: boolean;
  dryRun?: boolean;
  list?: boolean;
}

export async function backupCommand(ctx: Context, flags: BackupFlags): Promise<void> {
  const t0 = Date.now();
  const settings = loadSettings(ctx);
  if (flags.name) settings.project = checkProjectName(flags.name);

  if (flags.list) {
    requireAmber();
    amber(['list', settings.project], 'list the backups');
    return;
  }

  let selection = settings.selection;
  let remember = Boolean(flags.name);
  if (flags.all) {
    selection = {};
    remember = true;
  }
  if (flags.accounts?.length || flags.folders?.length || flags.since) {
    selection = {
      ...(flags.accounts?.length ? { accounts: accountIdsFor(ctx, flags.accounts) } : {}),
      ...(flags.folders?.length ? { folders: flags.folders.map((f) => path.resolve(f)) } : {}),
      ...(flags.since ? { since: flags.since } : {}),
    };
  }
  if (flags.pick) {
    selection = await pickSelection(ctx);
    remember = await confirm('Use this choice for future backups too?');
  }
  if (!flags.dryRun) requireAmber();

  const staged = await withTask('Preparing the backup…', (t) => stageBackup(ctx, {
    project: settings.project,
    selection,
    config: flags.config && settings.config,
    onProgress: (m) => t.update(`Preparing the backup: ${m}`),
  }), (r) => `Prepared ${plural(r.chats.length, 'chat')} from ${plural(r.accounts.length, 'account')}${r.config ? ' and your Claude config' : ''}`);

  if (remember) saveSettings(ctx, { ...settings, selection });
  info(`Chats: ${describe(ctx, selection)}${remember ? ' (saved for next time)' : ''}`);
  info(`Size before compression: ${size(staged.bytes)}. amber compresses it and only uploads what changed since last time.`);
  if (staged.missingTranscripts) warn(`${plural(staged.missingTranscripts, 'chat')} have no transcript on this PC; only their sidebar entry is kept.`);
  info('Logins are not included: on a new PC you sign in once per account.');

  if (out.json && flags.dryRun) {
    printJson({ project: staged.project, folder: staged.dir, selection, chats: staged.chats.map(({ indexPath: _i, transcript: _t, ...ch }) => ch) });
    return;
  }
  if (flags.dryRun) {
    say();
    table(staged.chats.slice(0, 20).map((ch) => [ch.title.slice(0, 60), c.dim(path.basename(ch.cwd)), when(ch.lastActivityAt), size(ch.bytes)]), ['CHAT', 'FOLDER', 'LAST ACTIVE', 'SIZE']);
    if (staged.chats.length > 20) say(c.dim(`  … and ${staged.chats.length - 20} more`));
    say(c.dim(`\n  Dry run: nothing was uploaded. The prepared folder is ${staged.dir}`));
    return;
  }

  say();
  amber(['backup', staged.dir], 'back up');
  done(`Backed up to amber as "${staged.project}"`, t0);
  info('On a new PC: amber login, then claude-switch restore');
}

// ------------------------------------------------------------------ restore

// claude-switch backups in amber, newest first, read from `amber list`.
function findBackups(): Array<{ project: string; latest: string }> {
  const r = amberQuiet(['list']);
  if (!r.ok) throw new CdsError('Could not list your amber backups.', r.out.trim().split('\n').pop() || 'Run "amber login" first.');
  const seen = new Map<string, string>();
  for (const line of r.out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 3 || cols[0] === 'ID') continue;
    const [, project, packed] = cols;
    if (project && /^claude-switch/i.test(project) && !seen.has(project)) seen.set(project, packed ?? '');
  }
  return [...seen].map(([project, latest]) => ({ project, latest }));
}

export interface RestoreFlags {
  name?: string;
  snapshot?: string;
  map?: string[];
  chats: boolean;
  launch: boolean;
}

export async function restoreCommand(ctx: Context, flags: RestoreFlags): Promise<void> {
  const t0 = Date.now();
  requireAmber();
  const maps = parseMaps(flags.map);
  let target = flags.snapshot ?? (flags.name ? checkProjectName(flags.name) : undefined);
  if (!target) {
    const found = findBackups();
    if (!found.length) throw new CdsError('No claude-switch backups found in amber.', 'If you renamed it, pass --name <amber project>. "amber list" shows them all.');
    if (found.length === 1 || out.yes) target = found[0]!.project;
    else {
      say(c.bold('\n  Which backup?'));
      found.forEach((b, i) => say(`  ${c.accent(String(i + 1).padStart(2))}  ${b.project}  ${c.dim(`last backed up ${b.latest}`)}`));
      const pick = await prompt(`Backup to restore (1-${found.length})`);
      const n = Number(pick);
      if (!Number.isInteger(n) || n < 1 || n > found.length) throw new CdsError('Cancelled.', undefined, 3);
      target = found[n - 1]!.project;
    }
  }

  const work = restoreWorkDir(ctx);
  amber(['restore', target, work, '--no-git'], 'restore the backup');
  say();
  const r = await withTask('Unpacking the backup…', () => restoreFromFolder(ctx, work, maps, { chats: flags.chats }),
    (x) => `Unpacked ${plural(x.chats, 'chat')} from ${x.host}`);

  if (r.profilesAdded.length) ok(`Added ${plural(r.profilesAdded.length, 'account')} to sign in to: ${r.profilesAdded.join(', ')}`);
  if (r.transcripts.restored || r.transcripts.kept) {
    ok(`Restored ${plural(r.transcripts.restored, 'transcript')}${r.transcripts.kept ? ` (${r.transcripts.kept} newer here, kept)` : ''}`);
  }

  // Accounts already set up on this PC get their chats now; the rest when you sign in.
  const ready = r.waitingFor.filter((a) => hasSidebar(ctx, a));
  const later = r.waitingFor.filter((a) => !ready.includes(a));
  if (ready.length) {
    const canCloseHere = !isAppRunning(ctx.install) || !startedByClaude(ctx.install);
    if (canCloseHere) {
      const wasRunning = await ensureClosed(ctx, 'add the restored chats to the sidebar');
      for (const a of ready) {
        await withTask(`Adding chats to ${accountName(ctx, a)}…`, () => applyPending(ctx, a),
          (y) => `${accountName(ctx, a)}: ${plural(y.added, 'chat')} added${y.updated ? `, ${y.updated} updated` : ''}`);
      }
      if (wasRunning && flags.launch) await launchApp(ctx.install);
    } else {
      later.push(...ready);
    }
  }
  if (later.length) info(`Chats for ${later.map((a) => accountName(ctx, a)).join(', ')} go into the sidebar the next time you sign in to or switch to that account.`);
  if (r.configDir) info(`Your Claude config from that PC (settings, memory, skills) is in ${r.configDir}`);

  done(`Restored "${target}"`, t0);
  const needSignIn = listProfiles(ctx.home).filter((p) => !profileHasLogin(ctx.home, p));
  if (needSignIn.length) say(`\n  Next: ${c.bold('claude-switch setup')} signs in to ${plural(needSignIn.length, 'account')} (once each).`);
}

// ------------------------------------------------------------------ setup

export async function setupCommand(ctx: Context): Promise<void> {
  const todo = listProfiles(ctx.home).filter((p) => !profileHasLogin(ctx.home, p) || p.status === 'needs-login');
  if (!todo.length) {
    ok('Every saved account can sign in on this PC already.');
    const pending = accountsWithPending(ctx);
    if (pending.length) info(`Chats waiting for: ${pending.map((a) => accountName(ctx, a)).join(', ')}. They go in when you switch to that account.`);
    return;
  }
  say(`\n  ${plural(todo.length, 'account')} to sign in to on this PC:`);
  for (const p of todo) say(`  ${c.dim('·')} ${p.name} ${c.dim(shortId(p.accountUuid))}`);
  say();
  if (await runOutsideDesktopIfNeeded(ctx, 'setup')) return;
  for (const p of todo) {
    if (!(await confirm(`Sign in to "${p.name}" now?`))) continue;
    await addAccount(ctx, p.name, { launch: true });
    say();
  }
}

