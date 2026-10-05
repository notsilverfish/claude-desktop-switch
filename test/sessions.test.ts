import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMerge, listAccounts, planMerge, sessionRoot } from '../src/core/sessions.js';
import { makeSandbox, UUID_A, UUID_B, type Sandbox } from './helpers.js';

const P1 = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;

let sb: Sandbox;
let vault: string;

function chat(account: string, project: string, n: number, opts: { activity?: number; title?: string; archived?: boolean } = {}) {
  const dir = path.join(sessionRoot(sb.data), account, project);
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    sessionId: `local_${id(n)}`,
    cliSessionId: id(n),
    title: opts.title ?? `chat ${n}`,
    cwd: `C:\\work\\${project.slice(0, 4)}`,
    lastActivityAt: opts.activity ?? 1000 + n,
    isArchived: opts.archived ?? false,
  };
  fs.writeFileSync(path.join(dir, `local_${id(n)}.json`), JSON.stringify(record));
  if (opts.archived) {
    fs.writeFileSync(path.join(dir, 'archived-sessions.idx'), JSON.stringify({ v: 1, archived: [`local_${id(n)}`] }));
  }
}
const deleteIn = (account: string, project: string, n: number) =>
  fs.writeFileSync(path.join(sessionRoot(sb.data), account, project, `deleted_${id(n)}`), '1791025699580');
const transcript = (n: number) => {
  const dir = path.join(sb.claudeHome, 'projects', 'C--work');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id(n)}.jsonl`), '{}\n');
};
const recordIn = (account: string, project: string, n: number) =>
  path.join(sessionRoot(sb.data), account, project, `local_${id(n)}.json`);

beforeEach(() => {
  sb = makeSandbox();
  vault = path.join(sb.home, 'vault');
  // Active account A has project P1 with chat 1 (older copy of B's) and deleted chat 2.
  chat(UUID_A, P1, 1, { activity: 10 });
  chat(UUID_A, P1, 2);
  deleteIn(UUID_A, P1, 2);
  // Account B: chat 1 (newer), 2 (deleted in A), 3 (new), 4 (archived), 5 in a project A never opened.
  chat(UUID_B, P1, 1, { activity: 99 });
  chat(UUID_B, P1, 2);
  chat(UUID_B, P1, 3);
  chat(UUID_B, P1, 4, { archived: true });
  chat(UUID_B, P2, 5);
  [1, 2, 3].forEach(transcript);
});
afterEach(() => sb.cleanup());

describe('sessions', () => {
  it('lists accounts without counting chats the user deleted', () => {
    const accounts = listAccounts(sb.data);
    expect(accounts.find((a) => a.accountId === UUID_A)).toMatchObject({ chats: 1, deleted: 1 });
    expect(accounts.find((a) => a.accountId === UUID_B)).toMatchObject({ chats: 5, deleted: 0 });
  });

  it('plans a merge that never resurrects deleted chats', () => {
    const plan = planMerge(sb.data, UUID_A, { vaultDir: vault });
    const byId = Object.fromEntries(plan.items.map((i) => [i.record.cliSessionId, i]));
    expect(byId[id(1)]?.action).toBe('update');
    expect(byId[id(3)]?.action).toBe('add');
    expect(byId[id(4)]).toMatchObject({ action: 'add', hasTranscript: false });
    expect(byId[id(2)]).toBeUndefined();
    expect(plan.deletedHere).toBe(1);
    expect([...plan.missingProject.keys()]).toEqual([P2]);
  });

  it('applies the merge, keeps archived chats archived, backs up and vaults', () => {
    const plan = planMerge(sb.data, UUID_A, { vaultDir: vault });
    const r = applyMerge(sb.data, plan, vault, sb.ctx.home.backups);
    expect(r).toMatchObject({ added: 2, updated: 1 });
    expect(JSON.parse(fs.readFileSync(recordIn(UUID_A, P1, 1), 'utf8')).lastActivityAt).toBe(99);
    expect(fs.existsSync(recordIn(UUID_A, P1, 3))).toBe(true);
    const idx = JSON.parse(fs.readFileSync(path.join(sessionRoot(sb.data), UUID_A, P1, 'archived-sessions.idx'), 'utf8'));
    expect(idx.archived).toContain(`local_${id(4)}`);
    // backup holds A's sidebar as it was
    expect(JSON.parse(fs.readFileSync(path.join(r.backupDir, P1, `local_${id(1)}.json`), 'utf8')).lastActivityAt).toBe(10);
    expect(fs.existsSync(path.join(vault, 'transcripts', `${id(3)}.jsonl`))).toBe(true);
    // a second merge has nothing left to do
    expect(planMerge(sb.data, UUID_A, { vaultDir: vault }).items).toHaveLength(0);
  });

  it('can limit the merge to chosen accounts and recover from an old vault', () => {
    expect(planMerge(sb.data, UUID_A, { vaultDir: vault, from: [UUID_A] }).items).toHaveLength(0);
    const oldVault = path.join(sb.root, 'old-vault');
    fs.mkdirSync(path.join(oldVault, 'session-indexes', P1), { recursive: true });
    fs.writeFileSync(path.join(oldVault, 'session-indexes', P1, `local_${id(7)}.json`),
      JSON.stringify({ sessionId: `local_${id(7)}`, cliSessionId: id(7), title: 'from old vault', lastActivityAt: 5 }));
    const plan = planMerge(sb.data, UUID_A, { vaultDir: vault, extraVaults: [oldVault] });
    expect(plan.items.some((i) => i.record.title === 'from old vault')).toBe(true);
  });

  it('skips malformed records', () => {
    fs.writeFileSync(path.join(sessionRoot(sb.data), UUID_B, P1, `local_${id(8)}.json`), '{ not json');
    expect(planMerge(sb.data, UUID_A, { vaultDir: vault }).invalid).toBe(1);
  });
});
