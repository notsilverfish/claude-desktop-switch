import fs from 'node:fs';
import path from 'node:path';
import { walkFiles } from '../util/fs.js';
import { readRecords, sessionRoot, transcriptRoot } from './sessions.js';
import { isGuid } from '../util/fs.js';

// Estimates what the token usage recorded in local Claude Code transcripts would
// cost on the Anthropic API. Reads usage metadata only; message text is ignored.
//
// Claude Code writes the same API response once per content block (thinking,
// text, tool_use), so responses are deduplicated by (session, message id),
// keeping the final (highest) output counter. Summing raw lines overcounts.

export const PRICING_CHECKED = '2026-09-25';
export const PRICING_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

// USD per million tokens. Cache writes: 1.25x input (5-minute TTL), 2x input
// (1-hour TTL). Cache reads: 0.1x input, except Opus 5.5 (0.05x) and Fable /
// Mythos 5.1 (0.025x).
interface Rates {
  uncached_input: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  output: number;
}
const rate = (input: number, output: number, readMultiplier = 0.1): Rates => ({
  uncached_input: input,
  cache_write_5m: input * 1.25,
  cache_write_1h: input * 2,
  cache_read: input * readMultiplier,
  output,
});

export const MODEL_RATES: Record<string, Rates> = {
  'claude-fable-5-1': rate(10, 50, 0.025),
  'claude-mythos-5-1': rate(10, 50, 0.025),
  'claude-fable-5': rate(10, 50),
  'claude-mythos-5': rate(10, 50),
  'claude-opus-5-5': rate(4, 20, 0.05),
  'claude-opus-5': rate(5, 25),
  'claude-opus-4-8': rate(5, 25),
  'claude-opus-4-7': rate(5, 25),
  'claude-opus-4-6': rate(5, 25),
  'claude-sonnet-5-5': rate(2, 10),
  'claude-sonnet-5': rate(2, 10),
  'claude-sonnet-4-6': rate(3, 15),
  'claude-haiku-4-5': rate(1, 5),
};

export const TOKEN_FIELDS = ['uncached_input', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output'] as const;
type TokenField = (typeof TOKEN_FIELDS)[number];

// "claude-haiku-4-5-20251001" -> "claude-haiku-4-5"
export function normalizeModel(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

export class Totals {
  requests = 0;
  uncached_input = 0;
  cache_write_5m = 0;
  cache_write_1h = 0;
  cache_read = 0;
  output = 0;
  thinking = 0;
  web_search = 0;
  web_fetch = 0;
  cost = 0;
  unpriced = 0;
  models = new Set<string>();

  add(v: UsageValues, model: string, cost: number | null): void {
    this.requests++;
    for (const k of [...TOKEN_FIELDS, 'thinking', 'web_search', 'web_fetch'] as const) this[k] += v[k];
    this.models.add(model);
    if (cost === null) this.unpriced++;
    else this.cost += cost;
  }

  get totalTokens(): number {
    return TOKEN_FIELDS.reduce((n, k) => n + this[k], 0);
  }

  get totalInput(): number {
    return this.uncached_input + this.cache_write_5m + this.cache_write_1h + this.cache_read;
  }

  toJSON() {
    return {
      requests: this.requests,
      ...Object.fromEntries(TOKEN_FIELDS.map((k) => [k, this[k]])),
      thinking: this.thinking,
      web_search: this.web_search,
      web_fetch: this.web_fetch,
      total_tokens: this.totalTokens,
      estimated_cost_usd: Number(this.cost.toFixed(6)),
      unpriced_responses: this.unpriced,
      models: [...this.models].sort(),
    };
  }
}

export interface UsageValues extends Record<TokenField, number> {
  thinking: number;
  web_search: number;
  web_fetch: number;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

export function usageValues(usage: Record<string, unknown>): { values: UsageValues; fallback: boolean } {
  const creation = usage.cache_creation as Record<string, unknown> | undefined;
  let w5 = 0;
  let w1 = 0;
  let fallback = false;
  if (creation && typeof creation === 'object') {
    w5 = num(creation.ephemeral_5m_input_tokens);
    w1 = num(creation.ephemeral_1h_input_tokens);
  } else {
    // Older logs only have the total; the default TTL was 5 minutes.
    w5 = num(usage.cache_creation_input_tokens);
    fallback = w5 > 0;
  }
  const details = usage.output_tokens_details as Record<string, unknown> | undefined;
  const tools = usage.server_tool_use as Record<string, unknown> | undefined;
  return {
    values: {
      uncached_input: num(usage.input_tokens),
      cache_write_5m: w5,
      cache_write_1h: w1,
      cache_read: num(usage.cache_read_input_tokens),
      output: num(usage.output_tokens),
      thinking: details ? num(details.thinking_tokens) : 0,
      web_search: tools ? num(tools.web_search_requests) : 0,
      web_fetch: tools ? num(tools.web_fetch_requests) : 0,
    },
    fallback,
  };
}

export function apiCost(v: UsageValues, model: string): number | null {
  const r = MODEL_RATES[normalizeModel(model)];
  if (!r) return null;
  return TOKEN_FIELDS.reduce((sum, k) => sum + (v[k] * r[k]) / 1_000_000, 0);
}

// project-dir/<session-id>/subagents/agent-*.jsonl belongs to <session-id>.
function ownerSession(rel: string): string {
  const parts = rel.split(/[\\/]/);
  if (parts.length >= 4 && parts.at(-2)?.toLowerCase() === 'subagents') return parts.at(-3)!;
  return path.basename(rel, '.jsonl');
}

export interface UsageReport {
  generatedAt: string;
  grand: Totals;
  sessions: Array<{ id: string; title: string | null; totals: Totals }>;
  models: Array<{ model: string; totals: Totals }>;
  diagnostics: {
    files: number;
    lines: number;
    parseErrors: number;
    syntheticRows: number;
    fallbackCacheRows: number;
    serviceTiers: string[];
  };
}

export interface UsageOptions {
  dataDir: string | null;
  since?: Date;
  onProgress?: (done: number, total: number) => void;
}

function sessionTitles(dataDir: string | null): Map<string, string> {
  const titles = new Map<string, { at: number; title: string }>();
  if (!dataDir) return new Map();
  const root = sessionRoot(dataDir);
  let accounts: string[] = [];
  try {
    accounts = fs.readdirSync(root).filter(isGuid);
  } catch {
    return new Map();
  }
  for (const a of accounts) {
    for (const r of readRecords(path.join(root, a), a).records) {
      const cur = titles.get(r.cliSessionId);
      if (!cur || r.lastActivityAt > cur.at) titles.set(r.cliSessionId, { at: r.lastActivityAt, title: r.title });
    }
  }
  return new Map([...titles].map(([k, v]) => [k, v.title]));
}

interface Candidate {
  model: string;
  usage: Record<string, unknown>;
  owner: string;
}

export function computeUsage(opts: UsageOptions): UsageReport {
  const root = transcriptRoot();
  const responses = new Map<string, Candidate>();
  const d = { files: 0, lines: 0, parseErrors: 0, syntheticRows: 0, fallbackCacheRows: 0, serviceTiers: new Set<string>() };
  const sinceMs = opts.since?.getTime();

  const files = [...walkFiles(root)].filter((f) => f.endsWith('.jsonl') && (!sinceMs || fs.statSync(f).mtimeMs >= sinceMs));
  for (const file of files) {
    d.files++;
    opts.onProgress?.(d.files, files.length);
    const owner = ownerSession(path.relative(root, file));
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      d.lines++;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line);
      } catch {
        d.parseErrors++;
        continue;
      }
      if (row.type !== 'assistant') continue;
      const message = row.message as Record<string, unknown> | undefined;
      if (!message || typeof message !== 'object') continue;
      const model = String(message.model ?? row.model ?? '');
      if (!model || model === '<synthetic>') {
        d.syntheticRows++;
        continue;
      }
      if (sinceMs && typeof row.timestamp === 'string' && Date.parse(row.timestamp) < sinceMs) continue;
      const usage = (message.usage ?? row.usage) as Record<string, unknown> | undefined;
      if (!usage || typeof usage !== 'object') continue;
      const messageId = String(message.id ?? row.uuid ?? '');
      if (!messageId) continue;
      const key = `${String(row.sessionId ?? owner)}|${messageId}`;
      const prev = responses.get(key);
      if (!prev || num(usage.output_tokens) > num(prev.usage.output_tokens)) responses.set(key, { model, usage, owner });
    }
  }

  const grand = new Totals();
  const sessions = new Map<string, Totals>();
  const models = new Map<string, Totals>();
  for (const r of responses.values()) {
    const { values, fallback } = usageValues(r.usage);
    if (fallback) d.fallbackCacheRows++;
    const model = normalizeModel(r.model);
    const cost = apiCost(values, model);
    grand.add(values, model, cost);
    if (!sessions.has(r.owner)) sessions.set(r.owner, new Totals());
    sessions.get(r.owner)!.add(values, model, cost);
    if (!models.has(model)) models.set(model, new Totals());
    models.get(model)!.add(values, model, cost);
    if (r.usage.service_tier) d.serviceTiers.add(String(r.usage.service_tier));
  }

  const titles = sessionTitles(opts.dataDir);
  return {
    generatedAt: new Date().toISOString(),
    grand,
    sessions: [...sessions].map(([id, totals]) => ({ id, title: titles.get(id) ?? null, totals }))
      .sort((a, b) => b.totals.cost - a.totals.cost),
    models: [...models].map(([model, totals]) => ({ model, totals })).sort((a, b) => b.totals.cost - a.totals.cost),
    diagnostics: { ...d, serviceTiers: [...d.serviceTiers].sort() },
  };
}

// ------------------------------------------------------------------ reports

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n: number) => n.toLocaleString('en-US');

// What the same tokens would cost with no caching (all input at the uncached rate).
export function noCacheCost(report: UsageReport): number | null {
  let total = 0;
  for (const { model, totals } of report.models) {
    const r = MODEL_RATES[model];
    if (!r) return null;
    total += (totals.totalInput * r.uncached_input + totals.output * r.output) / 1_000_000;
  }
  return total;
}

export function markdownReport(report: UsageReport): string {
  const g = report.grand;
  const nc = noCacheCost(report);
  const lines = [
    '# Claude Code local usage report', '',
    `Generated: ${report.generatedAt}`,
    `Pricing checked: ${PRICING_CHECKED} (${PRICING_SOURCE})`, '',
    '## Total', '',
    `- Main sessions: ${int(report.sessions.length)}`,
    `- Transcript files (including subagents): ${int(report.diagnostics.files)}`,
    `- Unique model responses: ${int(g.requests)}`,
    `- Total recorded tokens: ${int(g.totalTokens)}`,
    `- Equivalent API cost with the recorded caching: **${money(g.cost)}**`,
    ...(nc !== null ? [`- Equivalent cost with no prompt caching: ${money(nc)}`, `- Estimated cache savings: ${money(nc - g.cost)}`] : []),
    '', '## By model', '',
    '| Model | Responses | Uncached input | Cache writes (5m / 1h) | Cache reads | Output | Estimated cost |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...report.models.map(({ model, totals: t }) =>
      `| ${model}${MODEL_RATES[model] ? '' : ' (no price)'} | ${int(t.requests)} | ${int(t.uncached_input)} | ${int(t.cache_write_5m)} / ${int(t.cache_write_1h)} | ${int(t.cache_read)} | ${int(t.output)} | ${money(t.cost)} |`),
    '', `Thinking tokens (part of output): ${int(g.thinking)}. Server web searches: ${int(g.web_search)}; web fetches: ${int(g.web_fetch)}.`,
    '', '## By session', '', 'Subagent usage is included in its parent session.', '',
    '| Session | Responses | Total tokens | Estimated cost |', '|---|---:|---:|---:|',
    ...report.sessions.map((s) => {
      const title = (s.title ?? s.id).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      return `| ${title} (\`${s.id.slice(0, 8)}…\`) | ${int(s.totals.requests)} | ${int(s.totals.totalTokens)} | ${money(s.totals.cost)} |`;
    }),
    '', '## Scope and assumptions', '',
    '- Counts every local `~/.claude/projects/**/*.jsonl` transcript, including subagents.',
    '- Repeated rows of one response are deduplicated by message id; the final usage counter is kept.',
    '- Uses first-party standard-speed API prices and the cache TTL recorded in each response.',
    '- Sessions deleted from this PC, or stored only on another computer, cannot be counted.',
    '- This is an estimate from local metadata, not an invoice. Subscription plans are billed differently.',
    '', '## Diagnostics', '',
    `- Lines scanned: ${int(report.diagnostics.lines)}; parse errors: ${int(report.diagnostics.parseErrors)}; synthetic rows ignored: ${int(report.diagnostics.syntheticRows)}`,
    `- Older cache records assumed to be 5-minute writes: ${int(report.diagnostics.fallbackCacheRows)}`,
    `- Service tiers: ${report.diagnostics.serviceTiers.join(', ') || '(none)'}`,
  ];
  if (g.unpriced) lines.push('', `WARNING: ${int(g.unpriced)} responses used models without a known price; their tokens are counted but not their cost.`);
  return lines.join('\n') + '\n';
}

export function csvReport(report: UsageReport): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['session_id', 'title', 'models', 'responses', ...TOKEN_FIELDS, 'thinking', 'total_tokens', 'estimated_api_cost_usd'];
  const rows = report.sessions.map(({ id, title, totals: t }) => [
    id, title ?? '', [...t.models].sort().join(';'), t.requests, ...TOKEN_FIELDS.map((k) => t[k]), t.thinking, t.totalTokens, t.cost.toFixed(8),
  ]);
  return '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
