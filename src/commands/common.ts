import path from 'node:path';
import type { Context } from '../context.js';
import { CdsError } from '../errors.js';
import { isAppRunning, spawnDetached, startedByClaude } from '../platform/processes.js';
import { timestamp } from '../util/fs.js';
import { confirm, ok, say } from '../util/output.js';

// When this CLI runs inside Claude Desktop (e.g. its Code-tab terminal), closing
// Desktop would kill it mid-operation. Hand the work to a copy started outside
// Desktop's process tree instead. Returns true if the work was handed off.
export async function runOutsideDesktopIfNeeded(ctx: Context, command: string): Promise<boolean> {
  if (ctx.opts.background) return false;
  const install = ctx.install;
  if (!isAppRunning(install) || !startedByClaude(install)) return false;

  if (!(await confirm('This terminal belongs to Claude Desktop, which has to close for this. Continue in the background? Claude will reopen when it is done.'))) {
    throw new CdsError('Cancelled. Nothing was changed.', undefined, 3);
  }
  const args = process.argv.slice(2).filter((a) => a !== '--json');
  if (process.env.CDS_HOME && !args.includes('--home')) args.push('--home', process.env.CDS_HOME);
  if (process.env.CDS_DATA && !args.includes('--data-dir')) args.push('--data-dir', process.env.CDS_DATA);
  args.push('--background', '--yes');
  const log = path.join(ctx.home.logs, `${timestamp()}-${command}.log`);
  const pid = spawnDetached(args, log);
  ok(`Running in the background (pid ${pid}). Claude Desktop will close and reopen in a few seconds.`);
  say(`Log: ${log}`);
  return true;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  const units: Array<[number, string]> = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [secs, name] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      return `${n} ${name}${n > 1 ? 's' : ''} ago`;
    }
  }
  return 'just now';
}

export const shortId = (uuid: string | null) => (uuid ? uuid.slice(0, 8) : '—');
