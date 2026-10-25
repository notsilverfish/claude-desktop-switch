import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDataDir, type Install } from '../src/platform/install.js';
import { isDesktopProcess } from '../src/platform/processes.js';
import './helpers.js';

let root: string;
const saved = { ...process.env };

function dataFolder(dir: string, mtime: number): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  fs.utimesSync(file, mtime, mtime);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'csw-install-'));
  delete process.env.CDS_DATA;
  process.env.LOCALAPPDATA = path.join(root, 'Local');
  process.env.APPDATA = path.join(root, 'Roaming');
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(root, { recursive: true, force: true });
});

describe('finding the data folder', () => {
  const v2 = () => path.join(root, 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
  const v3 = () => path.join(root, 'Local', 'Claude-Data', 'claude_pzs8sxrjxfjjc');

  it('finds the Claude 3.x folder', () => {
    dataFolder(v3(), 2000);
    expect(resolveDataDir()).toEqual({ dir: v3(), source: 'claude-data' });
  });

  it('still finds the Claude 2.x Store folder', () => {
    dataFolder(v2(), 2000);
    expect(resolveDataDir()).toEqual({ dir: v2(), source: 'store' });
  });

  it('uses the most recently written folder when an update leaves the old one behind', () => {
    dataFolder(v2(), 1000);
    dataFolder(v3(), 2000);
    expect(resolveDataDir().dir).toBe(v3());
    dataFolder(v2(), 3000);
    expect(resolveDataDir().dir).toBe(v2());
  });

  it('prefers an explicit folder, and explains when nothing is found', () => {
    dataFolder(v3(), 2000);
    const custom = path.join(root, 'custom');
    dataFolder(custom, 1000);
    expect(resolveDataDir(custom).dir).toBe(custom);
    fs.rmSync(path.join(root, 'Local'), { recursive: true, force: true });
    expect(() => resolveDataDir()).toThrow(/not found/);
  });
});

describe('recognising Claude Desktop processes', () => {
  const app = String.raw`C:\Program Files\WindowsApps\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc\app`;
  const install: Install = { kind: 'store', version: '3', installDir: app, exe: null, family: 'Claude_pzs8sxrjxfjjc' };

  it('matches the app and its Code sessions in 2.x and 3.x locations, not a standalone CLI', () => {
    expect(isDesktopProcess(String.raw`${app}\Claude.exe`, install)).toBe(true);
    expect(isDesktopProcess(String.raw`C:\Users\u\AppData\Roaming\Claude\claude-code\2.1.286\abc\claude.exe`, install)).toBe(true);
    expect(isDesktopProcess(String.raw`C:\Users\u\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\claude-code\2.1.308\c17\claude.exe`, install)).toBe(true);
    expect(isDesktopProcess(String.raw`C:\Users\u\.local\bin\claude.exe`, install)).toBe(false);
  });
});
