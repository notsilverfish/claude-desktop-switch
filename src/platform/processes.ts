import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { CdsError } from '../errors.js';
import { sleep } from '../util/fs.js';
import { fakeMode, type Install } from './install.js';
import { psQuote, runPowerShell } from './powershell.js';

export interface ProcInfo {
  pid: number;
  ppid: number;
  exe: string;
  cmd: string;
}

export interface ClaudeProc {
  pid: number;
  kind: string; // 'main', 'code-session', or a Chromium --type (renderer, gpu-process, ...)
}

export interface QuitResult {
  wasRunning: boolean;
  forced: boolean;
  ms: number;
}

// In fake mode (tests) the app is simulated in memory.
export const fakeApp = {
  running: false,
  launches: 0,
  quits: 0,
  onLaunch: undefined as (() => void) | undefined,
};

// Safety net: a test run must never touch the real Claude Desktop (the developer
// may be running inside it). Real process control is refused under a test runner.
function assertNotTesting(action: string): void {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    throw new Error(`Refusing to ${action} the real Claude Desktop during tests (set CDS_FAKE_PROCESSES=1).`);
  }
}

const GRACEFUL_MS = 8000;
const EXIT_TIMEOUT_MS = 15000;

function parseProcs(raw: string): ProcInfo[] {
  if (!raw) return [];
  const rows = [].concat(JSON.parse(raw)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    pid: Number(r.ProcessId),
    ppid: Number(r.ParentProcessId),
    exe: String(r.ExecutablePath ?? ''),
    cmd: String(r.CommandLine ?? ''),
  }));
}

const SELECT = 'Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress';

export function listAllProcesses(): ProcInfo[] {
  return parseProcs(runPowerShell(`Get-CimInstance Win32_Process | ${SELECT}`));
}

function listClaudeNamed(): ProcInfo[] {
  return parseProcs(runPowerShell(`Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ${SELECT}`));
}

// Only processes belonging to Claude Desktop: its own exe, or the Claude Code
// binaries it bundles under ...\Claude\claude-code\. A standalone Claude Code CLI
// (also claude.exe) is deliberately not matched.
export function isDesktopProcess(exe: string, install: Install): boolean {
  const e = exe.toLowerCase();
  if (!e) return false;
  if (install.installDir && e.startsWith(install.installDir.toLowerCase() + path.sep)) return true;
  if (install.exe && e === install.exe.toLowerCase()) return true;
  // 2.x: ...\Claude\claude-code\<ver>\...  3.x: ...\Claude-Data\claude_<id>\claude-code\<ver>\...
  if (/\\claude[^\\]*\\claude-code\\[^\\]+\\/.test(e)) return true;
  return install.kind === 'installer' && /\\anthropicclaude\\app-[^\\]+\\claude\.exe$/.test(e);
}

export function claudeProcesses(install: Install, procs?: ProcInfo[]): ClaudeProc[] {
  if (fakeMode()) return fakeApp.running ? [{ pid: 1, kind: 'main' }] : [];
  return (procs ?? listClaudeNamed())
    .filter((p) => isDesktopProcess(p.exe, install))
    .map((p) => ({
      pid: p.pid,
      kind: /\\claude-code\\/i.test(p.exe) ? 'code-session' : /--type=([\w-]+)/.exec(p.cmd)?.[1] ?? 'main',
    }));
}

export function isAppRunning(install: Install): boolean {
  return claudeProcesses(install).length > 0;
}

// The data folder the running app actually uses, read from its child processes.
export function liveUserDataDir(install: Install): string | null {
  if (fakeMode()) return null;
  for (const p of listClaudeNamed()) {
    if (!isDesktopProcess(p.exe, install)) continue;
    const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(p.cmd);
    if (m) return m[1] ?? m[2] ?? null;
  }
  return null;
}

// True when this process descends from Claude Desktop (e.g. run from a Code-tab
// terminal). Quitting Desktop would then kill us halfway through.
export function startedByClaude(install: Install): boolean {
  if (fakeMode()) return process.env.CDS_FAKE_STARTED_BY_CLAUDE === '1';
  const procs = listAllProcesses();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let cur = byPid.get(process.pid);
  for (let i = 0; cur && i < 64; i++) {
    if (isDesktopProcess(cur.exe, install)) return true;
    cur = byPid.get(cur.ppid);
  }
  return false;
}

function taskkill(args: string[]): void {
  try {
    execFileSync('taskkill.exe', args, { stdio: 'ignore', windowsHide: true });
  } catch {
    // process already gone, or access denied; checked afterwards
  }
}

async function waitUntil(pred: () => boolean, timeoutMs: number, everyMs = 500, tick?: (elapsedMs: number) => void): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    tick?.(Date.now() - start);
    await sleep(everyMs);
  }
  return pred();
}

/** Progress for a step: a message, plus elapsed/total when the wait has a known length. */
export type Progress = (message: string, done?: number, total?: number) => void;

// Claude Desktop ignores a plain close request (it keeps running in the tray), so:
// ask politely, give it a few seconds to flush, then end the process tree.
export async function quitApp(
  install: Install,
  onProgress: Progress = () => {},
  gracefulMs = GRACEFUL_MS,
): Promise<QuitResult> {
  const t0 = Date.now();
  if (fakeMode()) {
    const wasRunning = fakeApp.running;
    if (wasRunning) fakeApp.quits++;
    fakeApp.running = false;
    return { wasRunning, forced: wasRunning, ms: 0 };
  }
  assertNotTesting('close');
  const procs = claudeProcesses(install);
  if (!procs.length) return { wasRunning: false, forced: false, ms: 0 };
  const mains = procs.filter((p) => p.kind === 'main');

  onProgress('Asking Claude Desktop to close…', 0, gracefulMs);
  for (const m of mains) taskkill(['/PID', String(m.pid)]);
  if (await waitUntil(() => !isAppRunning(install), gracefulMs, 500, (ms) => onProgress('Asking Claude Desktop to close…', ms, gracefulMs))) {
    return { wasRunning: true, forced: false, ms: Date.now() - t0 };
  }

  onProgress('Claude kept running in the tray; ending its processes…');
  for (const m of mains) taskkill(['/PID', String(m.pid), '/T', '/F']);
  // Code sessions can outlive the tree kill; end any stragglers individually.
  for (const p of claudeProcesses(install)) taskkill(['/PID', String(p.pid), '/F']);
  if (!(await waitUntil(() => !isAppRunning(install), EXIT_TIMEOUT_MS))) {
    throw new CdsError('Claude Desktop did not exit.', 'Quit it from the tray icon (right-click → Quit) and try again.');
  }
  await sleep(500); // let Windows release file handles
  return { wasRunning: true, forced: true, ms: Date.now() - t0 };
}

export async function launchApp(install: Install): Promise<boolean> {
  if (fakeMode()) {
    fakeApp.running = true;
    fakeApp.launches++;
    fakeApp.onLaunch?.();
    return true;
  }
  assertNotTesting('launch');
  if (install.kind === 'store' && install.family) {
    spawn('explorer.exe', [`shell:AppsFolder\\${install.family}!Claude`], { detached: true, stdio: 'ignore' }).unref();
  } else if (install.exe) {
    spawn(install.exe, [], { detached: true, stdio: 'ignore' }).unref();
  } else {
    return false;
  }
  return waitUntil(() => claudeProcesses(install).some((p) => p.kind === 'main'), 30000, 1000);
}

// Starts this CLI again outside Claude Desktop's process tree (created by WMI, so
// it is neither our child nor in Desktop's job object) and returns immediately.
// Used when the CLI runs inside Desktop, which the switch is about to close.
export function spawnDetached(args: string[], logFile: string): number {
  assertNotTesting('hand off to');
  const script = process.argv[1];
  if (!script) throw new CdsError('Cannot locate the CLI script to relaunch.');
  for (const a of args) {
    if (a.includes('"')) throw new CdsError('Arguments must not contain double quotes.');
  }
  const inner = [process.execPath, script, ...args].map((a) => `"${a}"`).join(' ');
  const commandLine = `cmd.exe /d /s /c "${inner} > "${logFile}" 2>&1"`;
  const raw = runPowerShell(
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)} }; ` +
    '"$($r.ReturnValue) $($r.ProcessId)"',
  );
  const [code, pid] = raw.split(' ').map(Number);
  if (code !== 0 || !pid) throw new CdsError(`Could not start a background process (WMI code ${code}).`);
  return pid;
}
