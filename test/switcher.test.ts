import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authDir, createProfile, findProfile, listProfiles, renameProfile, validateName, writeProfile } from '../src/core/profiles.js';
import { acquireLock, listBackups, readJournal } from '../src/core/safety.js';
import { addAccount, repair, saveCurrent, switchTo } from '../src/core/switcher.js';
import { CdsError } from '../src/errors.js';
import { fakeApp } from '../src/platform/processes.js';
import { makeSandbox, UUID_A, UUID_B, UUID_C, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  delete process.env.CDS_TEST_FAIL_AFTER_FILES;
  delete process.env.CDS_LOGIN_WAIT_MS;
  delete process.env.CDS_VERIFY_MS;
  process.env.CDS_VERIFY_MS = '0';
  sb.cleanup();
});

const launch = { launch: true };

describe('save', () => {
  it('saves the signed-in account and relaunches the app if it was open', async () => {
    sb.signIn(UUID_A, 'tokA');
    fakeApp.running = true;
    const r = await saveCurrent(sb.ctx, 'work', launch);
    expect(r.created).toBe(true);
    expect(r.profile).toMatchObject({ name: 'work', accountUuid: UUID_A, status: 'ok' });
    expect(fakeApp.quits).toBe(1);
    expect(fakeApp.running).toBe(true);
  });

  it('needs a name the first time, and refuses when signed out', async () => {
    sb.signIn(UUID_A, 'tokA');
    await expect(saveCurrent(sb.ctx, undefined, launch)).rejects.toThrow(/give it a name/);
    sb.signIn(UUID_A, '');
    await expect(saveCurrent(sb.ctx, 'x', launch)).rejects.toThrow(/not signed in/);
  });
});

describe('switch', () => {
  it('switches accounts, saving the outgoing one first', async () => {
    sb.signIn(UUID_A, 'tokA');
    await saveCurrent(sb.ctx, 'work', launch);
    sb.signIn(UUID_B, 'tokB'); // user signed in to B by hand

    const r = await switchTo(sb.ctx, 'work', launch);
    expect(sb.live().lastKnownAccountUuid).toBe(UUID_A);
    expect(sb.cookie()).toBe(`cookie-${UUID_A}`);
    expect(r.savedOutgoing).toMatchObject({ created: true, profile: { name: 'account-bbbbbbbb', accountUuid: UUID_B } });
    expect(readJournal(sb.ctx.home)).toBeNull();
    expect(listBackups(sb.ctx.home)[0]?.accountUuid).toBe(UUID_B);
    expect(fakeApp.running).toBe(true);

    // ...and back, with B's latest token
    sb.signIn(UUID_A, 'tokA-refreshed');
    await switchTo(sb.ctx, 'account-bbbbbbbb', launch);
    expect(sb.live()['oauth:tokenCacheV2']).toBe('tokB');
    // A's refreshed token was saved on the way out
    await switchTo(sb.ctx, 'work', launch);
    expect(sb.live()['oauth:tokenCacheV2']).toBe('tokA-refreshed');
  });

  it('does nothing when the profile is already signed in', async () => {
    sb.signIn(UUID_A, 'tokA');
    await saveCurrent(sb.ctx, 'work', launch);
    fakeApp.quits = 0;
    const r = await switchTo(sb.ctx, 'work', launch);
    expect(r.alreadyActive).toBe(true);
    expect(fakeApp.quits).toBe(0);
  });

  it('refuses logins saved before Claude was reinstalled', async () => {
    sb.signIn(UUID_A, 'tokA');
    await saveCurrent(sb.ctx, 'work', launch);
    sb.signIn(UUID_B, 'tokB');
    fs.writeFileSync(path.join(sb.data, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'NEWKEY' } }));
    await expect(switchTo(sb.ctx, 'work', launch)).rejects.toThrow(/reinstalled/);
    expect(sb.live().lastKnownAccountUuid).toBe(UUID_B);
  });

  it('marks a profile when Claude rejects its login after launch', async () => {
    sb.signIn(UUID_A, 'tokA');
    await saveCurrent(sb.ctx, 'work', launch);
    sb.signIn(UUID_B, 'tokB');
    process.env.CDS_VERIFY_MS = '300';
    fakeApp.onLaunch = () => sb.signIn(UUID_A, ''); // app drops the tokens
    const r = await switchTo(sb.ctx, 'work', launch);
    expect(r.login).toBe('logged-out');
    expect(findProfile(sb.ctx.home, 'work')?.status).toBe('needs-login');
  });

  it('recovers from a crash in the middle of a switch', async () => {
    sb.signIn(UUID_A, 'tokA');
    await saveCurrent(sb.ctx, 'work', launch);
    sb.signIn(UUID_B, 'tokB');
    process.env.CDS_TEST_FAIL_AFTER_FILES = '1';
    await expect(switchTo(sb.ctx, 'work', launch)).rejects.toThrow(/simulated crash/);
    expect(readJournal(sb.ctx.home)?.op).toBe('switch');
    // files were swapped, config was not: inconsistent until repaired
    expect(sb.cookie()).toBe(`cookie-${UUID_A}`);

    delete process.env.CDS_TEST_FAIL_AFTER_FILES;
    const r = await repair(sb.ctx, null, launch);
    expect(r.restoredFrom).toBeTruthy();
    expect(readJournal(sb.ctx.home)).toBeNull();
    expect(sb.live().lastKnownAccountUuid).toBe(UUID_B);
    expect(sb.cookie()).toBe(`cookie-${UUID_B}`);
  });
});

describe('add', () => {
  it('signs out locally, waits for the new sign-in, and saves it', async () => {
    sb.signIn(UUID_A, 'tokA');
    let first = true;
    fakeApp.onLaunch = () => {
      if (!first) return;
      first = false;
      expect(sb.live().lastKnownAccountUuid).toBeUndefined(); // sign-in screen
      setTimeout(() => sb.signIn(UUID_C, 'tokC'), 60);
    };
    const r = await addAccount(sb.ctx, 'home', launch);
    expect(r.created).toBe(true);
    expect(r.profile).toMatchObject({ name: 'home', accountUuid: UUID_C });
    expect(r.savedOutgoing?.profile.accountUuid).toBe(UUID_A);
    expect(fs.readFileSync(path.join(authDir(sb.ctx.home, r.profile.id), 'files', 'Network', 'Cookies'), 'utf8')).toBe(`cookie-${UUID_C}`);
    expect(listProfiles(sb.ctx.home).map((p) => p.name).sort()).toEqual(['account-aaaaaaaa', 'home']);
  });

  it('updates the existing profile when the same account signs in again', async () => {
    sb.signIn(UUID_A, 'tokA');
    await saveCurrent(sb.ctx, 'work', launch);
    let first = true;
    fakeApp.onLaunch = () => {
      if (first) setTimeout(() => sb.signIn(UUID_A, 'tokA2'), 30);
      first = false;
    };
    const r = await addAccount(sb.ctx, 'other-name', launch);
    expect(r.created).toBe(false);
    expect(r.profile.name).toBe('work');
    expect(listProfiles(sb.ctx.home)).toHaveLength(1);
  });

  it('puts the previous account back if Claude is closed before signing in', async () => {
    sb.signIn(UUID_A, 'tokA');
    let first = true;
    fakeApp.onLaunch = () => {
      if (first) setTimeout(() => (fakeApp.running = false), 30);
      first = false;
    };
    await expect(addAccount(sb.ctx, 'home', launch)).rejects.toThrow(CdsError);
    expect(sb.live().lastKnownAccountUuid).toBe(UUID_A);
    expect(sb.live()['oauth:tokenCacheV2']).toBe('tokA');
    expect(findProfile(sb.ctx.home, 'home')).toBeUndefined();
  });

  it('times out and restores the previous account', async () => {
    sb.signIn(UUID_A, 'tokA');
    process.env.CDS_LOGIN_WAIT_MS = '100';
    await expect(addAccount(sb.ctx, 'home', launch)).rejects.toThrow(/No new account/);
    expect(sb.live().lastKnownAccountUuid).toBe(UUID_A);
  });
});

describe('profiles and safety', () => {
  it('validates names', () => {
    expect(validateName('  me@work.com ')).toBe('me@work.com');
    expect(() => validateName('')).toThrow(CdsError);
    expect(() => validateName('bad"name')).toThrow(CdsError);
    expect(() => validateName('-dash')).toThrow(CdsError);
  });

  it('finds profiles by name, id or account prefix, and renames them', () => {
    const p = createProfile(sb.ctx.home, 'Work Account', UUID_A);
    expect(findProfile(sb.ctx.home, 'work account')?.id).toBe('work-account');
    expect(findProfile(sb.ctx.home, 'aaaaaaaa')?.id).toBe('work-account');
    expect(() => createProfile(sb.ctx.home, 'WORK ACCOUNT', UUID_B)).toThrow(/already exists/);
    renameProfile(sb.ctx.home, p, 'Job');
    expect(findProfile(sb.ctx.home, 'job')?.accountUuid).toBe(UUID_A);
    expect(findProfile(sb.ctx.home, 'work account')).toBeUndefined();
  });

  it('allows one operation at a time and clears stale locks', () => {
    const release = acquireLock(sb.ctx.home, 'test');
    expect(() => acquireLock(sb.ctx.home, 'other')).toThrow(/Another/);
    release();
    fs.writeFileSync(sb.ctx.home.lockFile, JSON.stringify({ pid: 999999, op: 'old', at: new Date().toISOString() }));
    acquireLock(sb.ctx.home, 'new')();
  });

  it('keeps a profile usable after metadata edits', () => {
    const p = createProfile(sb.ctx.home, 'x', UUID_A);
    p.status = 'needs-login';
    writeProfile(sb.ctx.home, p);
    expect(findProfile(sb.ctx.home, 'x')?.status).toBe('needs-login');
  });
});
