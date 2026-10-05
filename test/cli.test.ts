// Runs the bundled CLI (dist/claude-switch.mjs, built by `pretest`) the way a user
// would, against a fake install. The child inherits VITEST, so even without fake
// mode it would refuse to touch the real Claude Desktop.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BUNDLE = path.resolve('dist/claude-switch.mjs');
let root: string;
let env: NodeJS.ProcessEnv;

function run(...args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [BUNDLE, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'csw-cli-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'Network'), { recursive: true });
  fs.writeFileSync(path.join(data, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'K' } }));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    locale: 'en-US', lastKnownAccountUuid: 'aaaaaaaa-1111-4111-8111-111111111111', 'oauth:tokenCacheV2': 'tokA',
  }, null, '\t'));
  fs.writeFileSync(path.join(data, 'Network', 'Cookies'), 'cookieA');
  env = {
    ...process.env,
    CDS_FAKE_PROCESSES: '1',
    CDS_DATA: data,
    CDS_HOME: path.join(root, 'home'),
    CDS_CLAUDE_HOME: path.join(root, 'dot-claude'),
    CDS_VERIFY_MS: '0',
    NO_COLOR: '1',
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('bundled CLI', () => {
  it('prints grouped help and its version', () => {
    const help = run('--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('claude-switch save <name>');
    expect(help.stdout).toContain('When something looks wrong');
    expect(run('-v').stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('saves a profile and lists it', () => {
    expect(JSON.parse(run('list', '--json').stdout)).toEqual([]);
    const save = run('save', 'work', '-y');
    expect(save.code).toBe(0);
    const list = JSON.parse(run('list', '--json').stdout);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'work', active: true, hasLogin: true });
    expect(run('current').stdout.trim()).toBe('work');
  });

  it('rejects unknown commands and names', () => {
    const unknown = run('frobnicate');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Unknown command: frobnicate');
    const missing = run('use', 'nobody', '-y');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('No profile named "nobody"');
  });

  it('keeps stdout clean JSON while steps go to stderr', () => {
    const r = run('save', 'work', '-y', '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).profile.name).toBe('work');
  });
});
