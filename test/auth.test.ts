import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyAuth, captureAuth, cryptoFingerprint, readLiveAccount, readSavedAccount } from '../src/core/auth.js';
import { makeSandbox, UUID_A, UUID_B, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

describe('auth files', () => {
  it('captures and restores a login, keeping every other setting', () => {
    sb.signIn(UUID_A, 'tokA');
    const saved = path.join(sb.root, 'saved-a');
    expect(captureAuth(sb.data, saved).uuid).toBe(UUID_A);
    expect(readSavedAccount(saved)).toMatchObject({ uuid: UUID_A, hasTokens: true });

    sb.signIn(UUID_B, 'tokB');
    fs.writeFileSync(path.join(sb.data, 'Local Storage', 'leveldb', 'only-in-b.ldb'), 'x');
    const config = sb.live();
    config.locale = 'fr-FR'; // a user setting changed while on B
    fs.writeFileSync(path.join(sb.data, 'config.json'), JSON.stringify(config, null, '\t'));

    applyAuth(sb.data, saved);
    const live = sb.live();
    expect(live.lastKnownAccountUuid).toBe(UUID_A);
    expect(live['oauth:tokenCacheV2']).toBe('tokA');
    expect(live.locale).toBe('fr-FR');
    expect(live.windowSizeWasSignedIn).toBe(true);
    expect(sb.cookie()).toBe(`cookie-${UUID_A}`);
    // Folders are replaced, not merged: B's leftovers are gone.
    expect(fs.existsSync(path.join(sb.data, 'Local Storage', 'leveldb', 'only-in-b.ldb'))).toBe(false);
    // Desktop's tab-indented format is kept.
    expect(fs.readFileSync(path.join(sb.data, 'config.json'), 'utf8')).toContain('\n\t"');
  });

  it('clearing removes the login so the app shows its sign-in screen', () => {
    sb.signIn(UUID_A, 'tokA');
    applyAuth(sb.data, null);
    expect(readLiveAccount(sb.data)).toMatchObject({ uuid: null, hasTokens: false });
    expect(sb.cookie()).toBeNull();
    expect(sb.live().locale).toBe('en-US');
  });

  it('leaves no staging files behind', () => {
    sb.signIn(UUID_A, 'tokA');
    const saved = path.join(sb.root, 'saved');
    captureAuth(sb.data, saved);
    applyAuth(sb.data, saved);
    const leftovers = [...fs.readdirSync(sb.data), ...fs.readdirSync(path.join(sb.data, 'Network'))].filter((n) => n.includes('.cds-'));
    expect(leftovers).toEqual([]);
  });

  it('fingerprints the encryption key without exposing it', () => {
    const fp = cryptoFingerprint(sb.data);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain('KEY1');
  });
});

describe('safety net', () => {
  it('refuses to control the real Claude Desktop during tests', async () => {
    const { quitApp, launchApp } = await import('../src/platform/processes.js');
    const real = { kind: 'store' as const, version: 'x', installDir: 'C:\nowhere', exe: null, family: 'none' };
    delete process.env.CDS_FAKE_PROCESSES;
    try {
      await expect(quitApp(real)).rejects.toThrow(/Refusing/);
      await expect(launchApp(real)).rejects.toThrow(/Refusing/);
    } finally {
      process.env.CDS_FAKE_PROCESSES = '1';
    }
  });
});
