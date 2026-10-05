import path from 'node:path';
import { c as pc } from '../util/output.js';
import type { Context } from '../context.js';
import { readLiveAccount } from '../core/auth.js';
import { findByAccount, findProfile } from '../core/profiles.js';
import { acquireLock } from '../core/safety.js';
import { applyMerge, listAccounts, planMerge, readRecords, sessionRoot, type MergePlan } from '../core/sessions.js';
import { ensureClosed } from '../core/switcher.js';
import { CdsError } from '../errors.js';
import { launchApp } from '../platform/processes.js';
import { exists } from '../util/fs.js';
import { confirm, done, out, printJson, say, table, task, warn, withTask } from '../util/output.js';
import { relativeTime, runOutsideDesktopIfNeeded, shortId } from './common.js';

function activeAccount(ctx: Context): string {
  const live = readLiveAccount(ctx.dataDir);
  if (!live.uuid || !live.hasTokens) throw new CdsError('Claude Desktop is signed out.', 'Sign in or switch to a profile first.');
  return live.uuid;
}

const accountLabel = (ctx: Context, id: string) => findByAccount(ctx.home, id)?.name ?? `(unsaved ${shortId(id)})`;
const when = (ms: number) => (ms ? relativeTime(new Date(ms).toISOString()) : 'never');

// Profile name, account id, or id prefix -> account id.
function resolveAccount(ctx: Context, query: string): string {
  const profile = findProfile(ctx.home, query);
  if (profile?.accountUuid) return profile.accountUuid;
  const q = query.toLowerCase();
  const match = listAccounts(ctx.dataDir).find((a) => a.accountId === q || (q.length >= 8 && a.accountId.startsWith(q)));
  if (match) return match.accountId;
  throw new CdsError(`No account or profile matches "${query}".`, 'See accounts with: claude-switch sessions list');
}

export function sessionsListCommand(ctx: Context, query: string | undefined): void {
  const active = (() => {
    try {
      return activeAccount(ctx);
    } catch {
      return null;
    }
  })();

  if (!query) {
    const accounts = listAccounts(ctx.dataDir);
    if (out.json) {
      printJson(accounts.map((a) => ({ ...a, profile: findByAccount(ctx.home, a.accountId)?.name ?? null, active: a.accountId === active })));
      return;
    }
    if (!accounts.length) {
      say('No Code-tab chats found yet.');
      return;
    }
    table(accounts.map((a) => [
      a.accountId === active ? pc.green('●') : ' ',
      accountLabel(ctx, a.accountId),
      shortId(a.accountId),
      String(a.chats),
      a.deleted ? pc.dim(String(a.deleted)) : pc.dim('0'),
      when(a.lastActivityAt),
    ]), [' ', 'ACCOUNT', 'ID', 'CHATS', 'DELETED', 'LAST ACTIVE']);
    say();
    say(pc.dim('Each account has its own sidebar. Copy chats into the signed-in one with: claude-switch sessions merge'));
    return;
  }

  const accountId = resolveAccount(ctx, query);
  const { records } = readRecords(path.join(sessionRoot(ctx.dataDir), accountId), accountId);
  records.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  if (out.json) {
    printJson(records.map(({ path: _p, ...r }) => r));
    return;
  }
  say(`${pc.bold(accountLabel(ctx, accountId))} ${pc.dim(`${records.length} chats`)}`);
  table(records.map((r) => [
    r.title.length > 60 ? r.title.slice(0, 57) + '…' : r.title,
    pc.dim(path.basename(r.cwd) || '—'),
    when(r.lastActivityAt),
    r.archived ? pc.dim('archived') : '',
  ]), ['TITLE', 'FOLDER', 'LAST ACTIVE', '']);
}

function printPlan(ctx: Context, plan: MergePlan): void {
  const bySource = new Map<string, number>();
  for (const i of plan.items) {
    const src = i.record.accountId.startsWith('vault:') ? 'saved copies (vault)' : accountLabel(ctx, i.record.accountId);
    bySource.set(src, (bySource.get(src) ?? 0) + 1);
  }
  say(`Into ${pc.bold(accountLabel(ctx, plan.activeAccountId))}'s sidebar:`);
  for (const [src, n] of bySource) say(`  ${pc.green('+')} ${n} chat${n > 1 ? 's' : ''} from ${src}`);
  const shown = plan.items.slice(0, 12);
  for (const i of shown) {
    const flags = [i.action === 'update' ? 'newer copy' : '', i.record.archived ? 'archived' : '', i.hasTranscript ? '' : pc.yellow('transcript missing')]
      .filter(Boolean).join(', ');
    say(`    ${pc.dim('·')} ${i.record.title}${flags ? pc.dim(` (${flags})`) : ''}`);
  }
  if (plan.items.length > shown.length) say(pc.dim(`    … and ${plan.items.length - shown.length} more`));
  if (plan.alreadyPresent) say(pc.dim(`  ${plan.alreadyPresent} already there`));
  if (plan.deletedHere) say(pc.dim(`  ${plan.deletedHere} skipped because you deleted them in this account`));
  if (plan.missingProject.size) {
    warn(`Skipped chats from ${plan.missingProject.size} project(s) not opened in this account yet. Open each folder in Claude's Code tab once, then merge again:`);
    for (const cwd of plan.missingProject.values()) say(`    ${cwd || '(unknown folder)'}`);
  }
  const missing = plan.items.filter((i) => !i.hasTranscript).length;
  if (missing) warn(`${missing} chat(s) have no transcript on this PC and may not open.`);
}

export interface MergeFlags {
  from?: string[];
  vault?: string[];
  dryRun?: boolean;
  launch: boolean;
}

export async function sessionsMergeCommand(ctx: Context, flags: MergeFlags): Promise<void> {
  const t0 = Date.now();
  const active = activeAccount(ctx);
  const from = flags.from?.map((q) => resolveAccount(ctx, q));
  if (from?.includes(active)) throw new CdsError('Cannot merge an account into itself.');
  for (const v of flags.vault ?? []) {
    if (!exists(path.join(v, 'session-indexes'))) throw new CdsError(`Not a vault folder (no session-indexes inside): ${v}`);
  }
  const options = { from, extraVaults: flags.vault?.map((v) => path.resolve(v)), vaultDir: ctx.home.vault };

  const plan = await withTask('Comparing sidebars…', () => planMerge(ctx.dataDir, active, options), (p) => `Found ${p.items.length} chat${p.items.length === 1 ? '' : 's'} to copy`);
  if (out.json && flags.dryRun) {
    printJson({ ...plan, missingProject: Object.fromEntries(plan.missingProject), items: plan.items.map((i) => ({ action: i.action, hasTranscript: i.hasTranscript, title: i.record.title, from: i.record.accountId, sessionId: i.record.sessionId })) });
    return;
  }
  if (!out.json) printPlan(ctx, plan);
  if (!plan.items.length) {
    say();
    say('Nothing to merge.');
    return;
  }
  if (flags.dryRun) {
    say();
    say(pc.dim('Dry run: nothing was changed. Run without --dry-run to copy them.'));
    return;
  }
  if (!ctx.opts.background && !(await confirm(`Copy ${plan.items.length} chat${plan.items.length > 1 ? 's' : ''} into this sidebar?`))) {
    throw new CdsError('Cancelled. Nothing was changed.', undefined, 3);
  }
  if (await runOutsideDesktopIfNeeded(ctx, 'sessions-merge')) return;

  const release = acquireLock(ctx.home, 'sessions-merge');
  try {
    const wasRunning = await ensureClosed(ctx, 'update its sidebar');
    // Re-plan now that the app is closed and its files are final.
    const finalPlan = planMerge(ctx.dataDir, active, options);
    const r = await withTask('Copying chats…', () => applyMerge(ctx.dataDir, finalPlan, ctx.home.vault, ctx.home.backups),
      (x) => `Copied ${x.added} new and ${x.updated} updated chat${x.added + x.updated === 1 ? '' : 's'}`);
    if (r.vaulted.indexes || r.vaulted.transcripts) {
      say(pc.dim(`  Kept safety copies of ${r.vaulted.indexes} sidebar records and ${r.vaulted.transcripts} transcripts.`));
    }
    say(pc.dim(`  Previous sidebar backed up to ${r.backupDir}`));
    if (wasRunning && flags.launch) {
      const t = task('Starting Claude Desktop…');
      if (await launchApp(ctx.install)) t.succeed('Started Claude Desktop');
      else t.warn('Start Claude Desktop yourself');
    }
    done(`Merged ${r.added + r.updated} chat${r.added + r.updated === 1 ? '' : 's'}`, t0);
    if (out.json) printJson(r);
  } finally {
    release();
  }
}
