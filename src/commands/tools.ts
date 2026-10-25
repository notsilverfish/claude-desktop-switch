import path from 'node:path';
import { c as pc } from '../util/output.js';
import type { Context } from '../context.js';
import { exportConfig } from '../core/export.js';
import { findByAccount } from '../core/profiles.js';
import { computeUsage, csvReport, markdownReport, MODEL_RATES, noCacheCost, PRICING_CHECKED } from '../core/usage.js';
import { ensureDir, timestamp, writeFileAtomic } from '../util/fs.js';
import { parseSince } from '../util/time.js';
import { done, out, printJson, say, table, warn, withTask } from '../util/output.js';

function dataDirOrNull(ctx: Context): string | null {
  try {
    return ctx.dataDir;
  } catch {
    return null;
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function exportCommand(ctx: Context, opts: { out?: string; includeTranscripts?: boolean }): Promise<void> {
  const t0 = Date.now();
  const outDir = path.resolve(opts.out ?? path.join(ctx.home.exports, timestamp()));
  const r = await withTask('Exporting Claude configuration…', (t) => exportConfig({
    outDir,
    dataDir: dataDirOrNull(ctx),
    includeTranscripts: Boolean(opts.includeTranscripts),
    profileName: (id) => findByAccount(ctx.home, id)?.name ?? null,
    onProgress: (m) => t.update(`Exporting: ${m}`),
  }), (x) => `Exported ${x.files} files (${mb(x.bytes)})`);
  if (out.json) {
    printJson(r);
    return;
  }
  if (r.redactions) say(pc.dim(`  Replaced ${r.redactions} secret${r.redactions > 1 ? 's' : ''} with <REDACTED:…>.`));
  if (r.skipped.length) warn(`${r.skipped.length} file(s) could not be read (see export-log.txt).`);
  say(pc.dim('  Logins are never included.'));
  if (opts.includeTranscripts) warn('The export contains your chat history. Keep it private.');
  say(`  ${r.outDir}`);
  done('Export complete', t0);
}

export { parseSince } from '../util/time.js';

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

export async function usageCommand(ctx: Context, opts: { since?: string; out?: string; top?: string }): Promise<void> {
  const since = opts.since ? parseSince(opts.since) : undefined;
  const report = await withTask('Reading Claude Code transcripts…', (t) => computeUsage({
    dataDir: dataDirOrNull(ctx),
    since,
    onProgress: (n, total) => t.progress(n, total, `${n} / ${total} files`),
  }), (r) => `Read ${r.diagnostics.files} transcript files`);

  if (out.json) {
    printJson({
      generatedAt: report.generatedAt,
      since: since?.toISOString() ?? null,
      pricingChecked: PRICING_CHECKED,
      total: report.grand,
      noCacheCost: noCacheCost(report),
      models: report.models,
      sessions: report.sessions,
      diagnostics: report.diagnostics,
    });
  } else {
    const g = report.grand;
    say();
    table(report.models.map(({ model, totals: t }) => [
      model + (MODEL_RATES[model] ? '' : pc.yellow(' (no price)')),
      compact(t.requests),
      compact(t.totalInput),
      compact(t.output),
      money(t.cost),
    ]), ['MODEL', 'RESPONSES', 'INPUT', 'OUTPUT', 'API ESTIMATE']);
    say();
    const nc = noCacheCost(report);
    say(`${pc.bold('Total')}  ${compact(g.totalTokens)} tokens over ${report.sessions.length} sessions → ${pc.bold(money(g.cost))} at API prices`);
    if (nc !== null && nc > g.cost) say(pc.dim(`       Without prompt caching it would have been ${money(nc)} (saved ${money(nc - g.cost)}).`));
    if (g.unpriced) warn(`${g.unpriced} responses used models without a known price; their cost is not included.`);

    const top = Math.max(0, Number(opts.top ?? 5));
    if (top && report.sessions.length) {
      say();
      say(pc.dim('Most expensive sessions:'));
      for (const s of report.sessions.slice(0, top)) {
        const title = (s.title ?? s.id.slice(0, 8)).slice(0, 60);
        say(`  ${money(s.totals.cost).padStart(10)}  ${title}`);
      }
    }
    say();
    say(pc.dim(`Estimate from local metadata, API prices checked ${PRICING_CHECKED}. Subscription plans are billed differently.`));
  }

  if (opts.out) {
    const dir = ensureDir(path.resolve(opts.out));
    const stamp = timestamp();
    const md = path.join(dir, `claude-usage-${stamp}.md`);
    const csv = path.join(dir, `claude-usage-by-session-${stamp}.csv`);
    writeFileAtomic(md, markdownReport(report));
    writeFileAtomic(path.join(dir, 'LATEST.md'), markdownReport(report));
    writeFileAtomic(csv, csvReport(report));
    if (!out.json) {
      say(`Report: ${md}`);
      say(`CSV:    ${csv}`);
    }
  }
}
