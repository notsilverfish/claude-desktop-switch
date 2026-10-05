import type { Context } from '../context.js';
import { CdsError } from '../errors.js';
import { claudeProcesses, isAppRunning, launchApp, quitApp } from '../platform/processes.js';
import { removePath, sleep } from '../util/fs.js';
import { confirm, done, ok, onInterrupt, task, warn, withTask } from '../util/output.js';
import { applyAuth, cleanStaging, cryptoFingerprint, readLiveAccount, readSavedAccount } from './auth.js';
import {
  authDir, createProfile, findByAccount, findProfile, profileHasLogin, renameProfile, saveLiveInto, validateName,
  writeProfile, type Profile,
} from './profiles.js';
import { acquireLock, backupLiveAuth, clearJournal, readJournal, readLock, writeJournal } from './safety.js';

// Timings (overridable for tests).
const envMs = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const pollMs = () => envMs('CDS_POLL_MS', 2000);

export type LoginCheck = 'ok' | 'logged-out' | 'other-account' | 'not-checked';

export interface SwitchResult {
  target: Profile;
  alreadyActive: boolean;
  savedOutgoing: { profile: Profile; created: boolean } | null;
  backupDir: string | null;
  launched: boolean;
  login: LoginCheck;
}

export interface LaunchOptions {
  launch: boolean;
}

// ------------------------------------------------------------------ helpers

// Close Claude Desktop after confirming. Returns whether it was running.
export async function ensureClosed(ctx: Context, why: string): Promise<boolean> {
  const install = ctx.install;
  const procs = claudeProcesses(install);
  if (!procs.length) return false;
  const sessions = procs.filter((p) => p.kind === 'code-session').length;
  const detail = sessions ? ` ${sessions} running Claude Code session${sessions > 1 ? 's' : ''} in it will stop.` : '';
  if (!(await confirm(`Claude Desktop must close to ${why}.${detail} Continue?`))) {
    throw new CdsError('Cancelled. Nothing was changed.', undefined, 3);
  }
  await withTask('Closing Claude Desktop…', (t) => quitApp(install, (message, done, total) => {
    t.update(message);
    if (total) t.progress(done ?? 0, total);
    else t.progress(0, 0);
  }), () => 'Closed Claude Desktop');
  return true;
}

async function startApp(ctx: Context, text = 'Starting Claude Desktop…'): Promise<boolean> {
  const t = task(text);
  const started = await launchApp(ctx.install);
  if (started) t.succeed('Started Claude Desktop');
  else t.warn('Claude Desktop did not start within 30 seconds; start it yourself');
  return started;
}

// Save whoever is signed in right now before replacing them, so their latest
// (possibly refreshed) tokens are never lost. An account without a profile gets
// one automatically.
export function saveOutgoing(ctx: Context): { profile: Profile; created: boolean } | null {
  const live = readLiveAccount(ctx.dataDir);
  if (!live.uuid || !live.hasTokens) return null;
  let profile = findByAccount(ctx.home, live.uuid);
  let created = false;
  if (!profile) {
    let name = `account-${live.uuid.slice(0, 8)}`;
    for (let i = 2; findProfile(ctx.home, name); i++) name = `account-${live.uuid.slice(0, 8)}-${i}`;
    profile = createProfile(ctx.home, name, live.uuid);
    created = true;
  }
  saveLiveInto(ctx.home, ctx.dataDir, profile, ctx.install.version);
  return { profile, created };
}

async function saveOutgoingTask(ctx: Context): Promise<{ profile: Profile; created: boolean } | null> {
  const t = task('Saving the current account…');
  const r = saveOutgoing(ctx);
  if (!r) t.clear();
  else if (r.created) t.succeed(`Saved the current account as "${r.profile.name}" (rename it with: claude-switch rename)`);
  else t.succeed(`Saved "${r.profile.name}" with its latest login`);
  return r;
}

function checkUsable(ctx: Context, profile: Profile): void {
  if (!profileHasLogin(ctx.home, profile)) {
    throw new CdsError(`Profile "${profile.name}" has no saved login.`, `Sign in to it: claude-switch add "${profile.name}"`);
  }
  const current = cryptoFingerprint(ctx.dataDir);
  if (profile.cryptoKey && current && profile.cryptoKey !== current) {
    throw new CdsError(
      `The saved login for "${profile.name}" no longer works: Claude Desktop was reinstalled or reset since it was saved.`,
      `Sign in again to refresh it: claude-switch add "${profile.name}"`,
    );
  }
}

// After launch, watch config.json: if the app drops the tokens, the saved login
// was rejected (expired or signed out elsewhere).
export async function verifyLogin(
  ctx: Context,
  expectedUuid: string | null,
  timeoutMs = envMs('CDS_VERIFY_MS', 20000),
  onTick: (elapsedMs: number, totalMs: number) => void = () => {},
): Promise<LoginCheck> {
  const start = Date.now();
  let missing = 0;
  while (Date.now() - start < timeoutMs) {
    onTick(Date.now() - start, timeoutMs);
    await sleep(pollMs());
    let live;
    try {
      live = readLiveAccount(ctx.dataDir);
    } catch {
      continue; // mid-write
    }
    if (!live.hasTokens) {
      if (++missing >= 3) return 'logged-out';
      continue;
    }
    missing = 0;
    if (expectedUuid && live.uuid && live.uuid !== expectedUuid) return 'other-account';
  }
  return 'ok';
}

async function launchAndVerify(ctx: Context, profile: Profile): Promise<LoginCheck> {
  if (!(await startApp(ctx))) return 'not-checked';
  const t = task('Checking that Claude accepts the login…');
  const login = await verifyLogin(ctx, profile.accountUuid, undefined, (ms, total) =>
    t.progress(ms, total, `${Math.max(0, Math.ceil((total - ms) / 1000))}s left`));
  if (login === 'ok') {
    t.succeed(`Claude accepted the login for "${profile.name}"`);
  } else if (login === 'logged-out') {
    profile.status = 'needs-login';
    writeProfile(ctx.home, profile);
    t.fail(`Claude rejected the saved login for "${profile.name}" (expired or signed out)`);
    warn(`Sign in again with: claude-switch add "${profile.name}"`);
  } else {
    t.warn('Claude switched to a different account than expected');
  }
  return login;
}

// ------------------------------------------------------------------ switch

export async function switchTo(ctx: Context, query: string, opts: LaunchOptions): Promise<SwitchResult> {
  const t0 = Date.now();
  const release = acquireLock(ctx.home, 'switch');
  try {
    const target = findProfile(ctx.home, query);
    if (!target) throw new CdsError(`No profile named "${query}".`, 'See saved profiles with: claude-switch list');
    checkUsable(ctx, target);

    const live = readLiveAccount(ctx.dataDir);
    const saved = readSavedAccount(authDir(ctx.home, target.id));
    if (live.uuid && live.uuid === saved.uuid && live.hasTokens) {
      ok(`Already signed in as "${target.name}".`);
      const launched = opts.launch && !isAppRunning(ctx.install) ? await startApp(ctx) : false;
      return { target, alreadyActive: true, savedOutgoing: null, backupDir: null, launched, login: 'not-checked' };
    }

    await ensureClosed(ctx, `switch to "${target.name}"`);
    const savedOutgoing = await saveOutgoingTask(ctx);

    const backupDir = await withTask(`Switching to "${target.name}"…`, () => {
      const dir = backupLiveAuth(ctx.home, ctx.dataDir, 'before-switch');
      writeJournal(ctx.home, { op: 'switch', backupDir: dir, target: target.id });
      applyAuth(ctx.dataDir, authDir(ctx.home, target.id));
      if (readLiveAccount(ctx.dataDir).uuid !== saved.uuid) {
        throw new CdsError('The switch did not take effect (account id mismatch).', 'Run: claude-switch repair');
      }
      clearJournal(ctx.home);
      return dir;
    }, () => `Switched the login to "${target.name}"`);

    let login: LoginCheck = 'not-checked';
    if (opts.launch) login = await launchAndVerify(ctx, target);
    done(`Now using "${target.name}"`, t0);
    return { target, alreadyActive: false, savedOutgoing, backupDir, launched: login !== 'not-checked', login };
  } finally {
    release();
  }
}

// ------------------------------------------------------------------ add

export interface AddResult {
  profile: Profile;
  created: boolean;
  savedOutgoing: { profile: Profile; created: boolean } | null;
}

const loginWaitMs = () => envMs('CDS_LOGIN_WAIT_MS', 10 * 60_000);
const settleMs = () => envMs('CDS_SETTLE_MS', 20000);

// Sign a new account in: save the current one, clear the login locally (the
// server session of the current account stays valid), let the user sign in, then
// save the new login under `name`. Re-running with an existing name refreshes it.
export async function addAccount(ctx: Context, name: string, opts: LaunchOptions): Promise<AddResult> {
  const t0 = Date.now();
  const cleanName = validateName(name);
  const release = acquireLock(ctx.home, 'add');
  try {
    const existing = findProfile(ctx.home, cleanName);
    await ensureClosed(ctx, 'show the sign-in screen');
    const savedOutgoing = await saveOutgoingTask(ctx);

    const backupDir = await withTask('Signing out locally…', () => {
      const dir = backupLiveAuth(ctx.home, ctx.dataDir, 'before-add');
      writeJournal(ctx.home, { op: 'add', backupDir: dir });
      applyAuth(ctx.dataDir, null);
      clearJournal(ctx.home); // signed-out is a consistent state
      return dir;
    }, () => 'Signed out locally (the previous account stays valid)');

    // From here until the new login is saved, Ctrl+C puts the previous account back.
    const putBack = async () => {
      await quitApp(ctx.install);
      applyAuth(ctx.dataDir, backupDir);
      ok('Put the previous account back.');
      if (opts.launch) await launchApp(ctx.install);
    };
    const unregister = onInterrupt(putBack);
    let live: string | 'timeout' | 'closed';
    try {
      await startApp(ctx, 'Starting Claude Desktop at the sign-in screen…');
      const wait = task(`Waiting for you to sign in to the account for "${cleanName}"…`,
        'sign in in the Claude window · ctrl+c to cancel');
      live = await waitForLogin(ctx, loginWaitMs());
      if (live === 'timeout' || live === 'closed') {
        wait.warn(live === 'closed' ? 'Claude Desktop was closed before signing in' : 'No sign-in within 10 minutes');
        await putBack();
        throw new CdsError('No new account was added.', undefined, 3);
      }
      wait.succeed(`Signed in (account ${live.slice(0, 8)})`);
    } finally {
      unregister();
    }

    // The same account may already have a profile under another name.
    const sameAccount = findByAccount(ctx.home, live);
    let profile: Profile;
    let created = false;
    if (sameAccount && (!existing || sameAccount.id !== existing.id)) {
      warn(`That account is already saved as "${sameAccount.name}"; updating that profile instead.`);
      profile = sameAccount;
    } else if (existing) {
      if (existing.accountUuid && existing.accountUuid !== live) {
        warn(`"${existing.name}" was a different account before; it now points to the account you just signed in to.`);
      }
      profile = existing;
    } else {
      profile = createProfile(ctx.home, cleanName, live);
      created = true;
    }

    // Chromium writes cookies to disk periodically; give it time before closing.
    const settle = task('Letting Claude finish saving the login…');
    const total = Math.round(settleMs() / 1000);
    for (let left = total; left > 0; left--) {
      settle.progress(total - left, total, `${left}s left`);
      await sleep(1000);
    }
    if (settleMs() > 0 && settleMs() < 1000) await sleep(settleMs());
    settle.succeed('Claude saved the login');

    await withTask(`Saving profile "${profile.name}"…`, async () => {
      await quitApp(ctx.install);
      saveLiveInto(ctx.home, ctx.dataDir, profile, ctx.install.version);
    }, () => `Saved profile "${profile.name}"`);
    if (opts.launch) await startApp(ctx);
    done(`${created ? 'Added' : 'Refreshed'} "${profile.name}"`, t0);
    return { profile, created, savedOutgoing };
  } finally {
    release();
  }
}

async function waitForLogin(ctx: Context, timeoutMs: number): Promise<string | 'timeout' | 'closed'> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(pollMs());
    try {
      const live = readLiveAccount(ctx.dataDir);
      if (live.uuid && live.hasTokens) return live.uuid;
    } catch {
      // config.json mid-write
    }
    if (!isAppRunning(ctx.install)) return 'closed';
  }
  return 'timeout';
}

// ------------------------------------------------------------------ save

export interface SaveResult {
  profile: Profile;
  created: boolean;
  renamed: boolean;
}

// Save the signed-in account (needs the app closed briefly to copy its files).
export async function saveCurrent(ctx: Context, name: string | undefined, opts: LaunchOptions): Promise<SaveResult> {
  const t0 = Date.now();
  const release = acquireLock(ctx.home, 'save');
  try {
    const live = readLiveAccount(ctx.dataDir);
    if (!live.uuid || !live.hasTokens) {
      throw new CdsError('Claude Desktop is not signed in.', 'Sign in first, or add an account with: claude-switch add <name>');
    }
    let profile = findByAccount(ctx.home, live.uuid);
    let created = false;
    let renamed = false;
    if (!profile) {
      if (!name) throw new CdsError('This account is not saved yet; give it a name.', 'claude-switch save <name>');
      profile = createProfile(ctx.home, name, live.uuid);
      created = true;
    } else if (name && validateName(name) !== profile.name) {
      profile = renameProfile(ctx.home, profile, name);
      renamed = true;
    }
    const wasRunning = await ensureClosed(ctx, 'copy the login files');
    const p = profile;
    await withTask(`Saving profile "${p.name}"…`, () => {
      cleanStaging(ctx.dataDir);
      saveLiveInto(ctx.home, ctx.dataDir, p, ctx.install.version);
    }, () => `Saved profile "${p.name}"`);
    if (wasRunning && opts.launch) await startApp(ctx);
    done(`${created ? 'Saved' : 'Updated'} "${p.name}"`, t0);
    return { profile: p, created, renamed };
  } finally {
    release();
  }
}

// ------------------------------------------------------------------ repair

export interface RepairResult {
  restoredFrom: string | null;
  staleLockRemoved: boolean;
  stagingRemoved: number;
}

export async function repair(ctx: Context, restoreDir: string | null, opts: LaunchOptions): Promise<RepairResult> {
  const journal = readJournal(ctx.home);
  const lock = readLock(ctx.home);
  let staleLockRemoved = false;
  if (lock && lock.stale) {
    removePath(ctx.home.lockFile);
    staleLockRemoved = true;
  } else if (lock) {
    throw new CdsError(`Another operation is still running ("${lock.op}", pid ${lock.pid}).`);
  }

  const source = restoreDir ?? journal?.backupDir ?? null;
  let wasRunning = false;
  if (source) wasRunning = await ensureClosed(ctx, 'restore the login');
  const release = acquireLock(ctx.home, 'repair');
  try {
    const stagingRemoved = cleanStaging(ctx.dataDir);
    if (source) {
      await withTask('Restoring the login from the backup…', () => applyAuth(ctx.dataDir, source), () => 'Restored the login');
    }
    clearJournal(ctx.home);
    if (source && (wasRunning || opts.launch)) await startApp(ctx);
    return { restoredFrom: source, staleLockRemoved, stagingRemoved };
  } finally {
    release();
  }
}
