import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportConfig, redact } from '../src/core/export.js';
import { createProfile } from '../src/core/profiles.js';
import { saveLiveInto } from '../src/core/profiles.js';
import { apiCost, computeUsage, csvReport, markdownReport, normalizeModel } from '../src/core/usage.js';
import { parseSince } from '../src/commands/tools.js';
import { makeSandbox, UUID_A, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

describe('redaction', () => {
  it('replaces common secrets and leaves normal text alone', () => {
    const input = [
      '{"apiKey": "abcd1234efgh", "name": "keep me"}',
      'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'key sk-ant-api03-abcdefghijklmnop',
      'Authorization: Bearer abcdefghijklmnopqrstuvwx',
      'postgres://user:hunter2@db.example.com/app',
      'AKIAABCDEFGHIJKLMNOP',
      'just a normal sentence about tokens and keys',
    ].join('\n');
    const { text, count } = redact(input);
    expect(text).not.toMatch(/abcd1234efgh|ghp_abc|sk-ant-api03|hunter2|AKIAABCDEFGHIJKLMNOP/);
    expect(text).toContain('"name": "keep me"');
    expect(text).toContain('postgres://user:<REDACTED:DB_PASSWORD>@db.example.com');
    expect(text).toContain('just a normal sentence about tokens and keys');
    expect(count).toBeGreaterThanOrEqual(6);
  });
});

function writeTranscript(rel: string, rows: Array<object | string>) {
  const file = path.join(sb.claudeHome, 'projects', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
}
const assistant = (session: string, id: string, model: string, usage: object) =>
  ({ type: 'assistant', sessionId: session, timestamp: '2026-10-01T00:00:00Z', message: { id, model, usage } });

describe('usage', () => {
  const S1 = '11111111-1111-4111-8111-111111111111';

  it('deduplicates repeated rows, rolls subagents into their session, prices per model', () => {
    const u = { input_tokens: 1000, cache_read_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
    writeTranscript(`C--work/${S1}.jsonl`, [
      assistant(S1, 'msg1', 'claude-opus-5-5', { ...u, output_tokens: 10 }), // thinking block row
      assistant(S1, 'msg1', 'claude-opus-5-5', { ...u, output_tokens: 500 }), // final row of the same response
      { type: 'user', message: { content: 'hi' } },
      assistant(S1, 'syn', '<synthetic>', { output_tokens: 1 }),
      'not json',
    ]);
    writeTranscript(`C--work/${S1}/subagents/agent-x.jsonl`, [
      assistant('agent-x', 'msg2', 'claude-haiku-4-5-20251001', { input_tokens: 2_000_000, output_tokens: 1_000_000 }),
    ]);
    const r = computeUsage({ dataDir: sb.data });
    expect(r.grand.requests).toBe(2);
    expect(r.grand.output).toBe(1_000_500);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.id).toBe(S1);
    expect(r.diagnostics.syntheticRows).toBe(1);
    expect(r.diagnostics.parseErrors).toBe(1);
    // Opus 5.5: 1000 * $4 + 1M cache reads * $0.20 + 500 * $20 (per MTok) ; Haiku: 2M * $1 + 1M * $5
    const opus = 1000 * 4 / 1e6 + 0.2 + 500 * 20 / 1e6;
    expect(r.models.find((m) => m.model === 'claude-opus-5-5')!.totals.cost).toBeCloseTo(opus, 6);
    expect(r.models.find((m) => m.model === 'claude-haiku-4-5')!.totals.cost).toBeCloseTo(7, 6);
    expect(markdownReport(r)).toContain('claude-haiku-4-5');
    expect(csvReport(r).split('\r\n')[1]).toContain(S1);
  });

  it('handles older cache fields and unknown models', () => {
    expect(normalizeModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    const v = { uncached_input: 0, cache_write_5m: 1e6, cache_write_1h: 1e6, cache_read: 0, output: 0, thinking: 0, web_search: 0, web_fetch: 0 };
    expect(apiCost(v, 'claude-opus-5')).toBeCloseTo(6.25 + 10, 6);
    expect(apiCost(v, 'claude-opus-4-5')).toBeNull();
  });

  it('parses --since', () => {
    expect(Date.now() - parseSince('2d').getTime()).toBeGreaterThan(47 * 3600_000);
    expect(parseSince('2026-09-01').getUTCFullYear()).toBe(2026);
    expect(() => parseSince('soon')).toThrow();
  });
});

describe('export', () => {
  it('exports config redacted and never includes logins', () => {
    sb.signIn(UUID_A, 'tokA-SECRET-TOKEN');
    saveLiveInto(sb.ctx.home, sb.data, createProfile(sb.ctx.home, 'work', UUID_A), null);
    fs.mkdirSync(sb.claudeHome, { recursive: true });
    fs.writeFileSync(path.join(sb.claudeHome, 'settings.json'), JSON.stringify({ env: { MY_API_KEY: 'abcdefgh12345678xyz' } }));
    fs.writeFileSync(path.join(sb.claudeHome, '.credentials.json'), '{"secret":"x"}');
    fs.writeFileSync(path.join(sb.data, 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { s: { env: { TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123' } } } }));

    const outDir = path.join(sb.root, 'export');
    const r = exportConfig({ outDir, dataDir: sb.data, includeTranscripts: false, profileName: () => null });
    expect(r.files).toBeGreaterThan(2);
    const all = [...(function* walk(d: string): Generator<string> {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) yield* walk(p);
        else yield p;
      }
    })(outDir)];
    const names = all.map((f) => path.relative(outDir, f));
    expect(names.some((n) => /config\.json$/.test(n) && !/desktop_config/.test(n))).toBe(false);
    expect(names.some((n) => /Cookies|Local Storage|credentials|profiles/.test(n))).toBe(false);
    const blob = all.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(blob).not.toContain('tokA-SECRET-TOKEN');
    expect(blob).not.toContain('abcdefgh12345678xyz');
    expect(blob).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
  });
});
