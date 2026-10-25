import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseNumbers, backupCommand, restoreCommand } from '../src/commands/backup.js';
import {
  applySelection, encodeFolder, listChats, loadSettings, mapPath, mapTranscriptPath, stageBackup, type BackupManifest,
} from '../src/core/backup.js';
import { createProfile, findProfile, listProfiles, profileHasLogin, saveLiveInto } from '../src/core/profiles.js';
import { sessionRoot } from '../src/core/sessions.js';
import { addAccount } from '../src/core/switcher.js';
import { Context } from '../src/context.js';
import { fakeApp } from '../src/platform/processes.js';
import { makeSandbox, UUID_A, UUID_B, type Sandbox } from './helpers.js';

const P = 'a3a74801-312d-4c57-b7d7-fd513cc3aedd';
const id = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const WORK = String.raw`C:\Users\old\Projects\site`;
const PLAY = String.raw`C:\Users\old\Projects\game`;

let sb: Sandbox;
let store: string;

function chat(sbx: Sandbox, account: string, n: number, cwd: string, activity = Date.now() - n * 60_000) {
  const dir = path.join(sessionRoot(sbx.data), account, P);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `local_${id(n)}.json`), JSON.stringify({
    sessionId: `local_${id(n)}`, cliSessionId: id(n), title: `chat ${n}`, cwd, originCwd: cwd, lastActivityAt: activity,
  }));
  const tdir = path.join(sbx.claudeHome, 'projects', encodeFolder(cwd));
  fs.mkdirSync(path.join(tdir, id(n), 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(tdir, `${id(n)}.jsonl`), `{"n":${n}}\n`);
  fs.writeFileSync(path.join(tdir, id(n), 'subagents', 'agent-1.jsonl'), '{}\n');
}

function useSandbox(next: Sandbox) {
  process.env.CDS_DATA = next.data;
  process.env.CDS_HOME = next.home;
  process.env.CDS_CLAUDE_HOME = next.claudeHome;
}

beforeEach(() => {
  sb = makeSandbox();
  store = path.join(sb.root, 'amber-store');
  process.env.CDS_AMBER_BIN = path.resolve('test/fake-amber.mjs');
  process.env.FAKE_AMBER_STORE = store;
  // This PC: two accounts with saved profiles and three chats.
  sb.signIn(UUID_A, 'tokA');
  saveLiveInto(sb.ctx.home, sb.data, createProfile(sb.ctx.home, 'work', UUID_A), null);
  createProfile(sb.ctx.home, 'play', UUID_B);
  chat(sb, UUID_A, 1, WORK);
  chat(sb, UUID_A, 2, WORK, Date.now() - 40 * 86_400_000);
  chat(sb, UUID_B, 3, PLAY);
});
afterEach(() => {
  delete process.env.CDS_AMBER_BIN;
  delete process.env.FAKE_AMBER_STORE;
  sb.cleanup();
});

describe('choosing chats', () => {
  it('lists every chat once, with its accounts and transcript', () => {
    const chats = listChats(sb.data);
    expect(chats.map((c) => c.cliSessionId).sort()).toEqual([id(1), id(2), id(3)]);
    expect(chats.find((c) => c.cliSessionId === id(3))).toMatchObject({ accounts: [UUID_B], cwd: PLAY });
    expect(chats.every((c) => c.transcript)).toBe(true);
  });

  it('filters by account, folder, age and exclusions', () => {
    const chats = listChats(sb.data);
    const ids = (sel: Parameters<typeof applySelection>[1]) => applySelection(chats, sel).map((c) => c.cliSessionId).sort();
    expect(ids({ accounts: [UUID_B] })).toEqual([id(3)]);
    expect(ids({ folders: [String.raw`c:\users\old\projects\site\\`] })).toEqual([id(1), id(2)]);
    expect(ids({ since: '30d' })).toEqual([id(1), id(3)]);
    expect(ids({ exclude: [`local_${id(1)}`] })).toEqual([id(2), id(3)]);
  });

  it('parses picks like "1,3-4"', () => {
    expect(parseNumbers('1, 3-4', 5)).toEqual([0, 2, 3]);
    expect(parseNumbers('', 5)).toBeNull();
    expect(parseNumbers('all', 5)).toBeNull();
    expect(() => parseNumbers('6', 5)).toThrow();
    expect(() => parseNumbers('two', 5)).toThrow();
  });
});

describe('preparing a backup', () => {
  it('holds the chosen chats and the accounts list, never logins', () => {
    const r = stageBackup(sb.ctx, { project: 'claude-switch-test', selection: { accounts: [UUID_A] }, config: true });
    expect(r.chats).toHaveLength(2);
    const manifest = JSON.parse(fs.readFileSync(path.join(r.dir, 'claude-switch.json'), 'utf8')) as BackupManifest;
    expect(manifest.profiles.map((p) => p.name).sort()).toEqual(['play', 'work']);
    expect(manifest.chats.map((c) => c.cliSessionId).sort()).toEqual([id(1), id(2)]);
    expect(JSON.parse(fs.readFileSync(path.join(r.dir, '.amber.json'), 'utf8')).name).toBe('claude-switch-test');
    expect(fs.existsSync(path.join(r.dir, 'chats', 'transcripts', encodeFolder(WORK), id(1), 'subagents', 'agent-1.jsonl'))).toBe(true);
    // Nothing of chat 3 (another account), and no login files anywhere.
    const everything = fs.readdirSync(r.dir, { recursive: true }).map(String);
    expect(everything.some((f) => f.includes(id(3)))).toBe(false);
    expect(everything.some((f) => /Cookies|Local Storage|auth-config|profiles/.test(f))).toBe(false);
    expect(fs.readFileSync(path.join(r.dir, 'claude-switch.json'), 'utf8')).not.toContain('tokA');
  });

  it('leaves unchanged files alone, so amber can skip an unchanged backup', () => {
    stageBackup(sb.ctx, { project: 'p', selection: {}, config: true });
    expect(stageBackup(sb.ctx, { project: 'p', selection: {}, config: true }).changed).toBe(0);
    const r = stageBackup(sb.ctx, { project: 'p', selection: { accounts: [UUID_B] }, config: true });
    expect(r.changed).toBeGreaterThan(0); // chats 1 and 2 removed, manifest rewritten
    expect(fs.existsSync(path.join(r.dir, 'chats', 'session-indexes', P, `local_${id(1)}.json`))).toBe(false);
  });
});

describe('moving to a new PC', () => {
  it('backs up, restores elsewhere, and puts chats back when each account signs in', async () => {
    await backupCommand(sb.ctx, { pick: false, config: true, name: 'claude-switch-old' });
    expect(loadSettings(sb.ctx).project).toBe('claude-switch-old');

    // A fresh PC with a different username; nobody signed in yet.
    const pc = makeSandbox();
    process.env.FAKE_AMBER_STORE = store;
    useSandbox(pc);
    const ctx = new Context({ yes: true, quiet: true });
    try {
      await restoreCommand(ctx, { map: [String.raw`C:\Users\old=D:\me`], chats: true, launch: false });

      // Accounts are back as profiles waiting for a sign-in.
      expect(listProfiles(ctx.home).map((p) => p.name).sort()).toEqual(['play', 'work']);
      expect(profileHasLogin(ctx.home, findProfile(ctx.home, 'work')!)).toBe(false);
      // Transcripts went to the mapped folder.
      const moved = path.join(pc.claudeHome, 'projects', encodeFolder(String.raw`D:\me\Projects\site`), `${id(1)}.jsonl`);
      expect(fs.readFileSync(moved, 'utf8')).toBe(`{"n":1}\n`);

      // Signing in to "work" adds its chats to its sidebar, with the folder mapped.
      let first = true;
      fakeApp.onLaunch = () => {
        if (first) setTimeout(() => pc.signIn(UUID_A, 'tokA-new'), 30);
        first = false;
      };
      await addAccount(ctx, 'work', { launch: false });
      const rec = path.join(sessionRoot(pc.data), UUID_A, P, `local_${id(1)}.json`);
      expect(JSON.parse(fs.readFileSync(rec, 'utf8')).cwd).toBe(String.raw`D:\me\Projects\site`);
      expect(fs.existsSync(path.join(sessionRoot(pc.data), UUID_A, P, `local_${id(3)}.json`))).toBe(false); // play's chat stays with play
      expect(fs.existsSync(path.join(pc.home, 'pending', UUID_A))).toBe(false);
      expect(fs.existsSync(path.join(pc.home, 'pending', UUID_B))).toBe(true);
    } finally {
      fakeApp.onLaunch = undefined;
      useSandbox(sb);
      pc.cleanup();
    }
  });

  it('adds chats right away for accounts already on this PC, but never ones deleted here', async () => {
    await backupCommand(sb.ctx, { pick: false, config: false, all: true });
    const pc = makeSandbox();
    process.env.FAKE_AMBER_STORE = store;
    useSandbox(pc);
    const ctx = new Context({ yes: true, quiet: true });
    try {
      // "work" is already set up here, and chat 2 was deleted in its sidebar.
      const dir = path.join(sessionRoot(pc.data), UUID_A, P);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `deleted_${id(2)}`), '1');
      await restoreCommand(ctx, { chats: true, launch: false });
      expect(fs.existsSync(path.join(dir, `local_${id(1)}.json`))).toBe(true);
      expect(fs.existsSync(path.join(dir, `local_${id(2)}.json`))).toBe(false);
    } finally {
      useSandbox(sb);
      pc.cleanup();
    }
  });
});

describe('path mapping', () => {
  it('maps folders and transcript folder names', () => {
    const maps: Array<[string, string]> = [[String.raw`C:\Users\old`, String.raw`D:\me`]];
    expect(mapPath(String.raw`C:\Users\old\Projects\x`, maps)).toBe(String.raw`D:\me\Projects\x`);
    expect(mapPath(String.raw`C:\Users\older\x`, maps)).toBe(String.raw`C:\Users\older\x`);
    expect(mapTranscriptPath(`C--Users-old-Projects-x/${id(1)}.jsonl`, maps)).toBe(path.join(`D--me-Projects-x`, `${id(1)}.jsonl`));
  });
});
