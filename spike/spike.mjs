#!/usr/bin/env node
// Phase 0 spike for claude-desktop-switch.
//
// Answers: which files make up a Claude Desktop login, how to quit/launch the
// app reliably, and whether swapping those files switches accounts.
//
// Safety rules:
//  - Never prints or decrypts token values. Logs only file names, hashes, sizes,
//    account UUIDs and your answers.
//  - Refuses to write anything while Claude Desktop is running.
//  - Takes one full backup before the first write, and backs up the login files
//    before every later write. `rescue` puts the original login back.
//  - Refuses to run from a terminal that Claude Desktop started, because quitting
//    Desktop would kill the terminal running this script.
//
// Usage (from a normal PowerShell / Windows Terminal window):
//   node spike.mjs status            safe any time, read-only
//   node spike.mjs run               guided experiment (quits/relaunches Desktop)
//   node spike.mjs run2              part 2: minimal-file-set trials, judged by account UUID
//   node spike.mjs udd-test          try a second, isolated profile via --user-data-dir
//   node spike.mjs rescue            restore the login from the initial backup
//   node spike.mjs quit [--force] | launch | capture <label> | apply <label> [set] | diff <a> <b>

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

// CDS_DATA / CDS_STORE point the spike at a fake data folder for self-testing;
// in that mode the "is Desktop running" guard is skipped.
const TEST_MODE = Boolean(process.env.CDS_DATA);
const DATA = process.env.CDS_DATA ?? resolveDataDir();

// Microsoft Store install: the real folder is the package's LocalCache.
// %APPDATA%\Claude is only a projection of it while the app is running; once
// the app exits it shows an unrelated, nearly empty folder.
function resolveDataDir() {
  const packages = path.join(process.env.LOCALAPPDATA, 'Packages');
  try {
    for (const name of fs.readdirSync(packages)) {
      if (!name.startsWith('Claude_')) continue;
      const dir = path.join(packages, name, 'LocalCache', 'Roaming', 'Claude');
      if (fs.existsSync(path.join(dir, 'config.json'))) return dir;
    }
  } catch {}
  return path.join(process.env.APPDATA, 'Claude');
}
function assertDataDir() {
  if (!fs.existsSync(path.join(DATA, 'config.json'))) {
    throw new Error(`No config.json in ${DATA}. Refusing to continue (wrong data folder?).`);
  }
}
const STORE = process.env.CDS_STORE ?? path.join(process.env.LOCALAPPDATA, 'claude-desktop-switch-spike');
const CAPTURES = path.join(STORE, 'captures');
const BACKUPS = path.join(STORE, 'backups');
const RESULTS = path.join(STORE, 'results');
const STATE_FILE = path.join(STORE, 'state.json');
const LOG_FILE = path.join(RESULTS, 'log.jsonl');

// Top-level entries that are caches, binaries or logs: never captured or diffed.
const EXCLUDE_TOP = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad',
  'logs', 'sentry', 'claude-code', 'Shared Dictionary', 'VideoDecodeStats', 'shared_proto_db',
  'preview-last-frames', 'lockfile',
]);

// Candidate login state, grouped so trials can apply subsets.
const isAuthKey = (k) => k.startsWith('oauth:') || k === 'lastKnownAccountUuid';
const GROUPS = {
  cookies: ['Network/Cookies', 'Network/Cookies-journal'],
  web: ['Local Storage', 'IndexedDB', 'Session Storage', 'WebStorage'],
};
const SETS = {
  'config': { config: true, paths: [] },
  'config+cookies': { config: true, paths: [...GROUPS.cookies] },
  'config+cookies+web': { config: true, paths: [...GROUPS.cookies, ...GROUPS.web] },
};
const ALL = 'config+cookies+web';

// ------------------------------------------------------------------ utilities

fs.mkdirSync(RESULTS, { recursive: true });
fs.mkdirSync(CAPTURES, { recursive: true });
fs.mkdirSync(BACKUPS, { recursive: true });

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

function log(action, data = {}) {
  fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), action, ...data }) + '\n');
}
function say(msg = '') { console.log(msg); }
function heading(msg) { say(`\n=== ${msg} ===`); }

function ps(script) {
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

// Line queue instead of rl.question(): works for typed and piped input alike
// (rl.question drops lines that arrive before it is called).
let rl;
let inputClosed = false;
const pendingLines = [];
const lineWaiters = [];
function nextLine() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => (lineWaiters.length ? lineWaiters.shift()(line) : pendingLines.push(line)));
    rl.on('close', () => { inputClosed = true; while (lineWaiters.length) lineWaiters.shift()(''); });
  }
  return pendingLines.length ? Promise.resolve(pendingLines.shift()) : new Promise((r) => lineWaiters.push(r));
}
async function ask(question, choices) {
  for (;;) {
    process.stdout.write(`${question} `);
    const answer = (await nextLine()).trim().toLowerCase();
    if (!choices || choices.includes(answer)) return answer;
    if (inputClosed && !pendingLines.length) throw new Error('Input ended before the question was answered.');
    say(`  Please answer one of: ${choices.join(', ')}`);
  }
}
async function pause(msg = 'Press Enter to continue.') { await ask(msg); }

function readConfig(dir = DATA) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
}
function writeConfig(obj) {
  // Desktop writes config.json tab-indented; keep that. Write atomically.
  const target = path.join(DATA, 'config.json');
  const tmp = `${target}.cds-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, '\t'));
  fs.renameSync(tmp, target);
}
function cryptoFingerprint(dir = DATA) {
  try {
    const ls = JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf8'));
    return sha(ls?.os_crypt?.encrypted_key ?? '');
  } catch { return null; }
}

// ------------------------------------------------------------- app processes

let pkgCache;
function appPackage() {
  if (pkgCache) return pkgCache;
  const out = ps(`$p = Get-AppxPackage -Name 'Claude' | Select-Object -First 1; if ($p) { @{ family = $p.PackageFamilyName; location = $p.InstallLocation; version = [string]$p.Version } | ConvertTo-Json -Compress }`);
  pkgCache = out ? JSON.parse(out) : null;
  return pkgCache;
}

function allProcesses() {
  const out = ps(`Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress`);
  return out ? [].concat(JSON.parse(out)) : [];
}

function claudeProcesses(procs = allProcesses()) {
  const pkg = appPackage();
  const installDir = pkg?.location?.toLowerCase();
  return procs.filter((p) => {
    const exe = (p.ExecutablePath ?? '').toLowerCase();
    if (!exe) return false;
    // Code sessions report the projected %APPDATA% path, not DATA; match by shape.
    return (installDir && exe.startsWith(installDir)) || /\\claude\\claude-code\\/.test(exe)
      || exe.endsWith('\\anthropicclaude\\claude.exe');
  }).map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    kind: /claude-code/i.test(p.ExecutablePath) ? 'code-session'
      : /--type=([\w-]+)/.exec(p.CommandLine ?? '')?.[1] ?? 'main',
  }));
}

function isRunning() { return !TEST_MODE && claudeProcesses().length > 0; }

function assertClosed() {
  if (TEST_MODE) return;
  const procs = claudeProcesses();
  if (procs.length) {
    throw new Error(`Claude Desktop is running (${procs.length} processes). Quit it first: node spike.mjs quit`);
  }
}

function startedByClaude() {
  if (TEST_MODE) return false;
  const procs = allProcesses();
  const byPid = new Map(procs.map((p) => [p.ProcessId, p]));
  let cur = byPid.get(process.pid);
  for (let i = 0; cur && i < 40; i++) {
    if (/\\(windowsapps\\claude_|anthropicclaude\\|claude\\claude-code\\)/i.test(cur.ExecutablePath ?? '')) return true;
    cur = byPid.get(cur.ParentProcessId);
  }
  return false;
}

async function waitFor(pred, timeoutMs, everyMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(everyMs);
  }
  return pred();
}

const GRACEFUL_MS = 10000;
let forceApproved = false;  // asked once per run

async function quitApp({ force = forceApproved, interactive = true } = {}) {
  heading('Quitting Claude Desktop');
  let procs = claudeProcesses();
  if (!procs.length) { say('Not running.'); log('quit', { result: 'not-running' }); return true; }
  const mains = procs.filter((p) => p.kind === 'main');
  say(`Found ${procs.length} processes (${mains.length} main, ${procs.filter((p) => p.kind === 'code-session').length} Code sessions).`);

  // 1. Graceful: taskkill without /F sends WM_CLOSE to the app's windows.
  const t0 = Date.now();
  for (const m of mains) { try { execFileSync('taskkill.exe', ['/PID', String(m.pid)], { stdio: 'ignore' }); } catch {} }
  let closed = await waitFor(() => !isRunning(), GRACEFUL_MS);
  const gracefulMs = Date.now() - t0;
  const leftover = claudeProcesses();
  log('quit-graceful', { closed, ms: gracefulMs, leftover: leftover.map((p) => p.kind) });
  if (closed) { say(`Closed gracefully in ${(gracefulMs / 1000).toFixed(1)}s.`); return true; }

  say(`Graceful close did not finish after ${GRACEFUL_MS / 1000}s. Still running: ${leftover.map((p) => p.kind).join(', ')}`);
  if (!force && interactive) {
    force = (await ask('Force-kill the remaining Claude processes? (y = yes, also for the rest of this run / n)', ['y', 'n'])) === 'y';
    forceApproved = force;
  }
  if (!force) { log('quit', { result: 'gave-up' }); return false; }

  // 2. Forced: kill the whole tree, then any stragglers (Code sessions can be orphaned).
  for (const m of mains) { try { execFileSync('taskkill.exe', ['/PID', String(m.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
  for (const p of claudeProcesses()) { try { execFileSync('taskkill.exe', ['/PID', String(p.pid), '/F'], { stdio: 'ignore' }); } catch {} }
  closed = await waitFor(() => !isRunning(), 10000);
  log('quit-forced', { closed, leftover: claudeProcesses().map((p) => p.kind) });
  say(closed ? 'Force-closed.' : 'Some processes are still running.');
  return closed;
}

async function launchApp() {
  const pkg = appPackage();
  heading('Launching Claude Desktop');
  if (TEST_MODE) { say('(test mode: not launching)'); return true; }
  if (pkg) {
    spawn('explorer.exe', [`shell:AppsFolder\\${pkg.family}!Claude`], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const exe = path.join(process.env.LOCALAPPDATA, 'AnthropicClaude', 'claude.exe');
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  }
  const started = await waitFor(() => claudeProcesses().some((p) => p.kind === 'main'), 30000);
  log('launch', { started });
  say(started ? 'Started. Give it a few seconds to load.' : 'It did not start within 30s.');
  return started;
}

// --------------------------------------------------------- capture / restore

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (base === dir && EXCLUDE_TOP.has(e.name)) continue;
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function manifest(dir = DATA) {
  const files = {};
  for (const rel of walk(dir)) {
    try {
      const buf = fs.readFileSync(path.join(dir, rel));
      files[rel] = { size: buf.length, hash: sha(buf) };
    } catch (e) { files[rel] = { error: e.code }; }
  }
  const configKeys = {};
  try {
    for (const [k, v] of Object.entries(readConfig(dir))) configKeys[k] = sha(JSON.stringify(v));
  } catch {}
  return { files, configKeys };
}

function copyPath(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true });
  return true;
}

// Copies login candidates + a manifest of everything (for diffing) into captures/<label>.
function capture(label, { quiet = false } = {}) {
  assertClosed();
  assertDataDir();
  const dest = path.join(CAPTURES, label);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const config = readConfig();
  const authConfig = Object.fromEntries(Object.entries(config).filter(([k]) => isAuthKey(k)));
  fs.writeFileSync(path.join(dest, 'auth-config.json'), JSON.stringify(authConfig));
  for (const rel of [...GROUPS.cookies, ...GROUPS.web]) copyPath(path.join(DATA, rel), path.join(dest, 'files', rel));
  const meta = {
    label,
    at: new Date().toISOString(),
    accountUuid: config.lastKnownAccountUuid ?? null,
    appVersion: config.updaterLastSeenVersion ?? null,
    cryptoKey: cryptoFingerprint(),
  };
  fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest()));
  log('capture', meta);
  if (!quiet) say(`Captured "${label}" (account ${meta.accountUuid}).`);
  return meta;
}

function ensureInitialBackup() {
  const dest = path.join(BACKUPS, 'initial-full');
  if (fs.existsSync(path.join(dest, 'done'))) return;
  assertClosed();
  assertDataDir();
  say('Making a one-time full backup of the Claude data folder (caches and binaries excluded)...');
  fs.rmSync(dest, { recursive: true, force: true });
  for (const e of fs.readdirSync(DATA)) {
    if (EXCLUDE_TOP.has(e)) continue;
    copyPath(path.join(DATA, e), path.join(dest, 'data', e));
  }
  if (!fs.existsSync(path.join(dest, 'data', 'config.json'))) throw new Error('Backup is missing config.json; aborting.');
  fs.writeFileSync(path.join(dest, 'done'), new Date().toISOString());
  log('backup-initial', { dest });
  say(`  -> ${dest}`);
}

function backupAuth(reason) {
  const dest = path.join(BACKUPS, `${stamp()}-${reason}`);
  fs.mkdirSync(dest, { recursive: true });
  const config = readConfig();
  fs.writeFileSync(path.join(dest, 'auth-config.json'),
    JSON.stringify(Object.fromEntries(Object.entries(config).filter(([k]) => isAuthKey(k)))));
  for (const rel of [...GROUPS.cookies, ...GROUPS.web]) copyPath(path.join(DATA, rel), path.join(dest, 'files', rel));
  return dest;
}

// Replaces live login candidates with those from a capture/backup folder.
// setName picks which groups; `null` source clears them instead (logged-out state).
function applyAuth(sourceDir, setName, reason) {
  assertClosed();
  assertDataDir();
  ensureInitialBackup();
  const set = SETS[setName];
  const backup = backupAuth(reason);

  if (set.config) {
    const config = readConfig();
    for (const k of Object.keys(config)) if (isAuthKey(k)) delete config[k];
    if (sourceDir) Object.assign(config, JSON.parse(fs.readFileSync(path.join(sourceDir, 'auth-config.json'), 'utf8')));
    writeConfig(config);
  }
  for (const rel of set.paths) {
    const live = path.join(DATA, rel);
    fs.rmSync(live, { recursive: true, force: true });
    if (sourceDir) copyPath(path.join(sourceDir, 'files', rel), live);
  }
  log('apply', { source: sourceDir ? path.basename(sourceDir) : '(clear)', set: setName, reason, backup });
}

function captureDir(label) {
  const dir = path.join(CAPTURES, label);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) throw new Error(`No capture named "${label}"`);
  return dir;
}

// Merge the groups used in a trial back into a capture, so token refreshes made
// while that account was live are not lost (the "always save the outgoing
// account" rule the real tool will follow).
function refreshCapture(label, setName) {
  const dir = captureDir(label);
  const set = SETS[setName];
  if (set.config) {
    const config = readConfig();
    fs.writeFileSync(path.join(dir, 'auth-config.json'),
      JSON.stringify(Object.fromEntries(Object.entries(config).filter(([k]) => isAuthKey(k)))));
  }
  for (const rel of set.paths) {
    fs.rmSync(path.join(dir, 'files', rel), { recursive: true, force: true });
    copyPath(path.join(DATA, rel), path.join(dir, 'files', rel));
  }
  log('refresh-capture', { label, set: setName });
}

// ------------------------------------------------------------------- diffing

function topGroup(rel) {
  const parts = rel.split('/');
  return parts[0] === 'Network' || parts[0] === 'claude-code-sessions' ? parts.slice(0, 2).join('/') : parts[0];
}

function changedGroups(a, b) {
  const groups = new Set();
  for (const rel of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) {
    if (a.files[rel]?.hash !== b.files[rel]?.hash) groups.add(topGroup(rel));
  }
  const keys = new Set();
  for (const k of new Set([...Object.keys(a.configKeys), ...Object.keys(b.configKeys)])) {
    if (a.configKeys[k] !== b.configKeys[k]) keys.add(k);
  }
  return { groups, keys };
}

function diffCaptures(noiseA, noiseB, sigA, sigB) {
  const load = (l) => JSON.parse(fs.readFileSync(path.join(captureDir(l), 'manifest.json'), 'utf8'));
  const noise = noiseA ? changedGroups(load(noiseA), load(noiseB)) : { groups: new Set(), keys: new Set() };
  const signal = changedGroups(load(sigA), load(sigB));
  const report = {
    compared: { noise: noiseA ? [noiseA, noiseB] : null, signal: [sigA, sigB] },
    accountDependentFiles: [...signal.groups].filter((g) => !noise.groups.has(g)).sort(),
    changedAlsoWithoutSwitching: [...signal.groups].filter((g) => noise.groups.has(g)).sort(),
    accountDependentConfigKeys: [...signal.keys].filter((k) => !noise.keys.has(k)).sort(),
    configKeysChangingAnyway: [...signal.keys].filter((k) => noise.keys.has(k)).sort(),
  };
  fs.writeFileSync(path.join(RESULTS, 'diff.json'), JSON.stringify(report, null, 2));
  log('diff', report);
  return report;
}

function printDiff(r) {
  heading('What changes when the account changes');
  say('Config keys that differ between accounts (and not just over time):');
  r.accountDependentConfigKeys.forEach((k) => say(`  ${k}`));
  say('Config keys that change even without switching:');
  r.configKeysChangingAnyway.forEach((k) => say(`  ${k}`));
  say('Files/folders that differ between accounts (and not just over time):');
  r.accountDependentFiles.forEach((g) => say(`  ${g}`));
  say('Files/folders that also change without switching (inconclusive):');
  r.changedAlsoWithoutSwitching.forEach((g) => say(`  ${g}`));
}

// --------------------------------------------------------------- the runner

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { step: 0, latest: {}, trials: [] }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function accountShown(prompt = 'Which account is Claude showing now?') {
  say(`${prompt}\n  a) account A (the one you started with)\n  b) account B\n  l) login screen\n  x) error / broken / something else`);
  return ask('Answer a/b/l/x:', ['a', 'b', 'l', 'x']);
}

async function launchAndAsk(extraQuestions = []) {
  await launchApp();
  await pause('When Claude has finished loading, look at it and press Enter.');
  const shown = await accountShown();
  const extra = {};
  for (const [key, q] of extraQuestions) extra[key] = await ask(`${q} (y/n/s=skip)`, ['y', 'n', 's']);
  const uuidAfter = readConfig().lastKnownAccountUuid ?? null;
  return { shown, uuidAfter, ...extra };
}

async function run() {
  if (startedByClaude()) {
    say('This terminal was started by Claude Desktop. Quitting Desktop would kill it mid-experiment.');
    say('Open a normal Windows Terminal / PowerShell window (Start menu) and run this again there.');
    process.exit(2);
  }
  const s = loadState();
  const step = async (n, title, fn) => {
    if (s.step >= n) return;
    heading(`Step ${n}: ${title}`);
    await fn();
    s.step = n;
    saveState(s);
  };

  if (s.step === 0) {
    say(`This walks through Phase 0. It takes about 15-20 minutes and needs:
  - Claude Desktop logged into your usual account (call it A).
  - A second account you own (B) that you can sign into.
It will quit and relaunch Claude Desktop several times. All your login files are
backed up first; if anything goes wrong, run:  node spike.mjs rescue
Progress is saved, so you can rerun "run" to continue where it stopped.
Results go to: ${RESULTS}`);
    if ((await ask('Start? (y/n)', ['y', 'n'])) !== 'y') return;
  }

  await step(1, 'Quit test', async () => {
    const ok = await quitApp();
    if (!ok) throw new Error('Could not quit Claude Desktop; nothing was changed.');
  });

  if (s.step >= 1 && s.step < 99 && isRunning()) {
    say('Claude Desktop is open; quitting it before continuing.');
    if (!(await quitApp())) throw new Error('Could not quit Claude Desktop; nothing was changed.');
  }

  await step(2, 'Capture account A', async () => {
    ensureInitialBackup();
    const meta = capture('A1');
    s.accountA = meta.accountUuid;
  });

  await step(3, 'Baseline: relaunch without switching', async () => {
    const r = await launchAndAsk();
    log('baseline', r);
    if (r.shown !== 'a') say('Unexpected: A should still be shown. Continuing, but this is noted.');
    if (!(await quitApp())) throw new Error('Could not quit.');
    capture('A2');
    s.latest.A = 'A2';
  });

  await step(4, 'Log out locally (without telling the server) and sign into B', async () => {
    applyAuth(null, ALL, 'clear-for-B');
    const r = await launchAndAsk();
    log('after-clear', r);
    s.clearResult = r.shown;
    if (r.shown !== 'l') {
      say('Removing those files did NOT log the app out. That is an important finding.');
      say('Putting account A back and stopping here; come back to Claude with the results.');
      await quitApp();
      applyAuth(captureDir(s.latest.A), ALL, 'restore-A');
      await launchApp();
      s.step = 99; saveState(s);
      throw new Error('Stopped after step 4 (clearing did not log out).');
    }
    say('\nNow sign into account B in the Claude window yourself.');
    say('Wait until it has fully loaded, and open the Code tab once.');
    await pause('Press Enter when B is fully signed in.');
    if (!(await quitApp())) throw new Error('Could not quit.');
    const meta = capture('B1');
    s.accountB = meta.accountUuid;
    s.latest.B = 'B1';
    if (meta.accountUuid === s.accountA) say('Note: the account UUID did not change. Was B a different account?');
  });

  await step(5, 'Diff A vs B', async () => {
    printDiff(diffCaptures('A1', 'A2', 'A2', 'B1'));
  });

  // Live state is B here. Each trial: apply part of A, see what shows, reset to B.
  const trialSets = Object.keys(SETS);
  for (let i = 0; i < trialSets.length; i++) {
    const setName = trialSets[i];
    await step(6 + i, `Trial: switch to A using only "${setName}"`, async () => {
      applyAuth(captureDir(s.latest.A), setName, `trial-${setName}`);
      const r = await launchAndAsk([['sidebar', "Does the Code tab sidebar show A's chats?"]]);
      const trial = { set: setName, ...r, expectedUuid: s.accountA };
      s.trials.push(trial);
      log('trial', trial);
      if (!(await quitApp())) throw new Error('Could not quit.');
      if (r.shown === 'a') refreshCapture(s.latest.A, setName);
      // Reset to B using everything, then save B again so B's capture stays fresh.
      applyAuth(captureDir(s.latest.B), ALL, 'reset-to-B');
    });
  }

  await step(10, 'Switch back to A for good', async () => {
    applyAuth(captureDir(s.latest.A), ALL, 'final-A');
    const r = await launchAndAsk();
    log('final', r);
    s.final = r.shown;
    if (r.shown !== 'a') say('A did not come back cleanly. Run "node spike.mjs rescue" if needed, then tell Claude.');
  });

  writeSummary(s);
  heading('Done');
  say(`Summary: ${path.join(RESULTS, 'summary.md')}`);
  say('Go back to the Claude Code chat and say "phase 0 done".');
  say('Optional extra test (second isolated window): node spike.mjs udd-test');
}

function writeSummary(s) {
  let diff = null;
  try { diff = JSON.parse(fs.readFileSync(path.join(RESULTS, 'diff.json'), 'utf8')); } catch {}
  const lines = [
    '# Phase 0 results', '',
    `- App: ${appPackage()?.version ?? 'unknown'} (${appPackage() ? 'Microsoft Store' : 'installer'})`,
    `- Account A: ${s.accountA}`, `- Account B: ${s.accountB}`,
    `- Clearing login files logged the app out: ${s.clearResult === 'l' ? 'yes' : `no (${s.clearResult})`}`,
    `- Final switch back to A worked: ${s.final === 'a' ? 'yes' : `no (${s.final})`}`, '',
    '## Trials (apply part of A on top of B)', '',
    '| set | shown | uuid after launch | expected | A sidebar |', '|---|---|---|---|---|',
    ...s.trials.map((t) => `| ${t.set} | ${t.shown} | ${t.uuidAfter} | ${t.expectedUuid} | ${t.sidebar} |`), '',
    '## Diff', '', '```json', JSON.stringify(diff, null, 2), '```',
  ];
  fs.writeFileSync(path.join(RESULTS, 'summary.md'), lines.join('\n'));
}

// ------------------------------------------------------------ the runner, v2
//
// Run 1 showed clearing works and a full switch B->A works, but answers like
// "a/b" were ambiguous. v2 judges by account UUID and asks with your own names.
// Live state at start: account A. Each trial applies part of B, observes, then
// switches fully back to A (so every trial also re-tests a full switch).

const B_SOURCE_BACKUP = '2026-10-05T17-22-07-326Z-restore-A'; // B's login, saved by run 1

function liveAuthSummary() {
  const config = readConfig();
  return {
    uuid: config.lastKnownAccountUuid ?? null,
    hasTokens: Object.keys(config).some((k) => k.startsWith('oauth:')),
    tokenHash: sha(JSON.stringify(config['oauth:tokenCacheV2'] ?? null)),
  };
}

function importBFromRun1(s) {
  if (fs.existsSync(path.join(CAPTURES, 'B1', 'meta.json'))) return;
  const src = path.join(BACKUPS, B_SOURCE_BACKUP);
  const auth = JSON.parse(fs.readFileSync(path.join(src, 'auth-config.json'), 'utf8'));
  const dest = path.join(CAPTURES, 'B1');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'auth-config.json'), JSON.stringify(auth));
  copyPath(path.join(src, 'files'), path.join(dest, 'files'));
  const meta = { label: 'B1', at: new Date().toISOString(), accountUuid: auth.lastKnownAccountUuid, importedFrom: B_SOURCE_BACKUP };
  fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2));
  log('import-B', meta);
  s.accountB = auth.lastKnownAccountUuid;
}

async function observe(s, expectUuid) {
  await launchApp();
  await pause('When Claude has finished loading, look at it and press Enter.');
  const nameA = s.names[s.accountA];
  const nameB = s.names[s.accountB];
  say(`What do you see?\n  1) signed in as ${nameA}\n  2) signed in as ${nameB}\n  3) the sign-in screen\n  4) an error / something broken`);
  const answer = { 1: 'A', 2: 'B', 3: 'login', 4: 'error' }[await ask('Answer 1-4:', ['1', '2', '3', '4'])];
  const live = liveAuthSummary();
  const actual = live.uuid === s.accountA ? 'A' : live.uuid === s.accountB ? 'B' : live.uuid;
  const expected = expectUuid === s.accountA ? 'A' : 'B';
  if (answer !== actual && answer !== 'login' && answer !== 'error') {
    say(`Note: you said ${answer} but the app's account ID says ${actual}. Both are recorded.`);
  }
  return { answer, uuidSays: actual, expected, hasTokens: live.hasTokens, ok: answer === expected && actual === expected };
}

async function run2() {
  if (startedByClaude()) {
    say('This terminal was started by Claude Desktop. Open a normal Windows Terminal window and run it there.');
    process.exit(2);
  }
  const s = loadState();
  s.v2 ??= { step: 0, trials: [] };
  s.names ??= {};
  const v = s.v2;
  const step = async (n, title, fn) => {
    if (v.step >= n) return;
    heading(`Step ${n}: ${title}`);
    await fn();
    v.step = n;
    saveState(s);
  };

  await step(1, 'Name your two accounts', async () => {
    importBFromRun1(s);
    say(`Run 1 found two accounts:\n  first:  ${s.accountA} (signed in now)\n  second: ${s.accountB} (the one you signed into during run 1)`);
    s.names[s.accountA] = (await ask('Name for the account signed in RIGHT NOW (e.g. its email or "work"):')) || 'first account';
    s.names[s.accountB] = (await ask('Name for the OTHER account you signed into during run 1:')) || 'second account';
  });

  if (v.step < 99 && isRunning()) {
    if (!(await quitApp())) throw new Error('Could not quit Claude Desktop; nothing was changed.');
  }

  await step(2, `Save ${s.names[s.accountA]} as it is now`, async () => {
    const live = liveAuthSummary();
    if (live.uuid !== s.accountA) throw new Error(`Expected ${s.names[s.accountA]} to be live, but found ${live.uuid}. Nothing was changed.`);
    capture('A3');
    s.latest.A = 'A3';
    s.latest.B ??= 'B1';
  });

  const trialSets = Object.keys(SETS);
  for (let i = 0; i < trialSets.length; i++) {
    const setName = trialSets[i];
    await step(3 + i, `Trial ${i + 1}/3: switch to ${s.names[s.accountB]} using only "${setName}"`, async () => {
      applyAuth(captureDir(s.latest.B), setName, `v2-trial-${setName}`);
      const r = await observe(s, s.accountB);
      const trial = { set: setName, ...r };
      v.trials.push(trial);
      log('v2-trial', trial);
      say(r.ok ? 'Result: the switch worked.' : 'Result: the switch did NOT fully work.');
      if (!(await quitApp())) throw new Error('Could not quit.');
      // Always save the outgoing account: keep B's tokens if the app refreshed them.
      if (liveAuthSummary().uuid === s.accountB) {
        if (r.ok && setName === ALL) { capture('B2'); s.latest.B = 'B2'; }
        else refreshCapture(s.latest.B, r.ok ? setName : 'config');
      }
      applyAuth(captureDir(s.latest.A), ALL, 'v2-back-to-A');
    });
  }

  await step(6, `Final check: back on ${s.names[s.accountA]}`, async () => {
    const r = await observe(s, s.accountA);
    v.final = r;
    log('v2-final', r);
    say(r.ok ? `Back on ${s.names[s.accountA]}.` : 'Did not land on the first account. Run "node spike.mjs rescue" and tell Claude.');
  });

  if (fs.existsSync(path.join(CAPTURES, 'B2', 'manifest.json'))) printDiff(diffCaptures('A1', 'A2', 'A3', 'B2'));
  writeSummary2(s);
  heading('Done');
  say(`Summary: ${path.join(RESULTS, 'summary.md')}`);
  say('Go back to the Claude Code chat and say "phase 0 done".');
}

function writeSummary2(s) {
  const v = s.v2;
  let diff = null;
  try { diff = JSON.parse(fs.readFileSync(path.join(RESULTS, 'diff.json'), 'utf8')); } catch {}
  const lines = [
    '# Phase 0 results', '',
    `- App: ${appPackage()?.version ?? 'unknown'} (${appPackage() ? 'Microsoft Store' : 'installer'})`,
    `- A: ${s.names[s.accountA]} (${s.accountA})`, `- B: ${s.names[s.accountB]} (${s.accountB})`,
    '- Run 1: clearing login files logged the app out; a full switch B -> A worked.', '',
    '## Trials: apply part of B on top of A, then full switch back to A', '',
    '| set | you saw | account ID says | expected | tokens present | ok |', '|---|---|---|---|---|---|',
    ...v.trials.map((t) => `| ${t.set} | ${t.answer} | ${t.uuidSays} | ${t.expected} | ${t.hasTokens} | ${t.ok} |`), '',
    `Final switch back to A: ${v.final?.ok ? 'ok' : JSON.stringify(v.final)}`, '',
    '## Diff', '', '```json', JSON.stringify(diff, null, 2), '```',
  ];
  fs.writeFileSync(path.join(RESULTS, 'summary.md'), lines.join('\n'));
}

// --------------------------------------------------- --user-data-dir trial

async function uddTest() {
  const pkg = appPackage();
  const exe = pkg ? path.join(pkg.location, 'app', 'Claude.exe') : path.join(process.env.LOCALAPPDATA, 'AnthropicClaude', 'claude.exe');
  const profile = path.join(STORE, 'udd-profile');
  fs.mkdirSync(profile, { recursive: true });
  heading('--user-data-dir test');
  say(`Starting a second Claude with its own data folder:\n  ${profile}`);
  say('Your normal Claude window (if open) is not touched.');
  const before = new Set(claudeProcesses().map((p) => p.pid));
  let spawnError = null;
  try {
    const child = spawn(exe, [`--user-data-dir=${profile}`], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => { spawnError = e.code; });
    child.unref();
  } catch (e) { spawnError = e.code; }
  await sleep(8000);
  const created = fs.readdirSync(profile);
  const newProcs = claudeProcesses().filter((p) => !before.has(p.pid));
  say(`New processes: ${newProcs.length}; files created in profile folder: ${created.length}`);
  say('What happened?\n  n) a NEW separate window with a login screen\n  s) it just focused my existing Claude window\n  e) error / nothing appeared\n  o) other');
  const seen = await ask('Answer n/s/e/o:', ['n', 's', 'e', 'o']);
  let login = 's';
  if (seen === 'n') {
    say('Optional: sign into an account in that new window to see if both run at once.');
    login = await ask('Did signing in work and do both windows run side by side? (y/n/s=skip)', ['y', 'n', 's']);
  }
  const result = { spawnError, newProcesses: newProcs.length, profileFiles: created.length, seen, login };
  log('udd-test', result);
  fs.writeFileSync(path.join(RESULTS, 'udd-test.json'), JSON.stringify(result, null, 2));
  say('Close that extra window when done. Result saved.');
}

// ------------------------------------------------------------------- status

function status() {
  const pkg = appPackage();
  const procs = claudeProcesses();
  let config = {};
  try { config = readConfig(); } catch {}
  const st = loadState();
  say(`Data folder:     ${DATA}${fs.existsSync(path.join(DATA, 'config.json')) ? '' : '  (NO config.json!)'}`);
  say(`Install:         ${pkg ? `Microsoft Store ${pkg.version} (${pkg.family})` : 'not a Store install'}`);
  say(`Running:         ${procs.length ? `yes, ${procs.length} processes (${procs.filter((p) => p.kind === 'code-session').length} Code sessions)` : 'no'}`);
  say(`Active account:  ${config.lastKnownAccountUuid ?? '(none)'}`);
  say(`Login keys:      ${Object.keys(config).filter(isAuthKey).join(', ') || '(none)'}`);
  say(`Crypto key fp:   ${cryptoFingerprint()}`);
  say(`Started by Claude Desktop: ${startedByClaude() ? 'yes (do not run "run" from here)' : 'no'}`);
  say(`Spike store:     ${STORE}`);
  say(`Runner step:     ${st.step}`);
  say(`Captures:        ${fs.readdirSync(CAPTURES).join(', ') || '(none)'}`);
}

// ---------------------------------------------------------------------- main

const [cmd, ...args] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'status': status(); break;
    case 'run': await run(); break;
    case 'run2': await run2(); break;
    case 'quit': await quitApp({ force: args.includes('--force') }); break;
    case 'launch': await launchApp(); break;
    case 'capture': if (!args[0]) throw new Error('capture <label>'); capture(args[0]); break;
    case 'apply': {
      if (!SETS[args[1] ?? ALL]) throw new Error(`apply <label> [${Object.keys(SETS).join('|')}]`);
      applyAuth(captureDir(args[0]), args[1] ?? ALL, 'manual');
      say(`Applied "${args[1] ?? ALL}" from ${args[0]}.`);
      break;
    }
    case 'diff': printDiff(diffCaptures(null, null, args[0], args[1])); break;
    case 'udd-test': await uddTest(); break;
    case 'rescue': {
      const src = path.join(BACKUPS, 'initial-full', 'data');
      if (!fs.existsSync(src)) throw new Error('No initial backup exists, so nothing was ever changed.');
      if (isRunning() && !(await quitApp())) throw new Error('Quit Claude Desktop first.');
      const config = JSON.parse(fs.readFileSync(path.join(src, 'config.json'), 'utf8'));
      const dir = path.join(STORE, 'rescue-src');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'auth-config.json'),
        JSON.stringify(Object.fromEntries(Object.entries(config).filter(([k]) => isAuthKey(k)))));
      for (const rel of [...GROUPS.cookies, ...GROUPS.web]) copyPath(path.join(src, rel), path.join(dir, 'files', rel));
      applyAuth(dir, ALL, 'rescue');
      say('Original login restored from the initial backup. Starting Claude...');
      await launchApp();
      break;
    }
    default:
      say('Commands: status | run | run2 | udd-test | rescue | quit [--force] | launch | capture <label> | apply <label> [set] | diff <a> <b>');
  }
} catch (e) {
  log('error', { cmd, message: e.message });
  console.error(`\nError: ${e.message}`);
  process.exitCode = 1;
} finally {
  rl?.close();
}
