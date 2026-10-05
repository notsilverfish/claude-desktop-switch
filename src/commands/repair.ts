import type { Context } from '../context.js';
import { findByAccount } from '../core/profiles.js';
import { listBackups, readJournal } from '../core/safety.js';
import { repair } from '../core/switcher.js';
import { CdsError } from '../errors.js';
import { ok, out, printJson, say, table } from '../util/output.js';
import { runOutsideDesktopIfNeeded, shortId } from './common.js';

export function backupsCommand(ctx: Context): void {
  const backups = listBackups(ctx.home);
  if (out.json) {
    printJson(backups);
    return;
  }
  if (!backups.length) {
    say('No login backups yet. One is made automatically before every change.');
    return;
  }
  table(
    backups.map((b) => [b.name.slice(0, 15), b.reason, shortId(b.accountUuid), findByAccount(ctx.home, b.accountUuid)?.name ?? '']),
    ['WHEN', 'REASON', 'ACCOUNT', 'PROFILE'],
  );
  say();
  say('Restore one with: claude-switch repair --from <WHEN>   (or --from latest)');
}

export async function repairCommand(ctx: Context, opts: { from?: string; launch: boolean }): Promise<void> {
  let restoreDir: string | null = null;
  if (opts.from) {
    const backups = listBackups(ctx.home);
    const match = opts.from === 'latest' ? backups[0] : backups.find((b) => b.name.startsWith(opts.from!));
    if (!match) throw new CdsError(`No backup matching "${opts.from}".`, 'List them with: claude-switch backups');
    restoreDir = match.dir;
  }
  const needsClose = Boolean(restoreDir ?? readJournal(ctx.home));
  if (needsClose && (await runOutsideDesktopIfNeeded(ctx, 'repair'))) return;
  const r = await repair(ctx, restoreDir, opts);
  if (out.json) {
    printJson(r);
    return;
  }
  if (!r.restoredFrom && !r.staleLockRemoved && !r.stagingRemoved) ok('Nothing to repair.');
  if (r.staleLockRemoved) ok('Removed a stale lock.');
  if (r.stagingRemoved) ok(`Removed ${r.stagingRemoved} leftover file(s) from an interrupted switch.`);
}
