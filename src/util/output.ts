import readline from 'node:readline';
import { CdsError } from '../errors.js';

// Terminal output, in the style of Claude Code and amber:
//
//   ✓ Closed Claude Desktop                                   8.2s
//   ✓ Saved "personal" with its latest login                  0.1s
//   ⠹ Checking that Claude accepts the login  ━━━━━━━━╸─────────────  12s
//
// Live steps go to stderr, so stdout stays clean for scripts and --json. Without a
// terminal (piped, CI, background log files) there is no animation: only the
// finished lines are printed.

export interface OutputOptions {
  json: boolean;
  yes: boolean;
  quiet: boolean;
}

export const out: OutputOptions = { json: false, yes: false, quiet: false };

const err = process.stderr;
const forced = () => process.env.CDS_FORCE_ANIMATION === '1';
const live = () => !out.quiet && (forced() || (Boolean(err.isTTY) && !process.env.CI && process.env.CDS_NO_ANIMATION !== '1'));
const colorOn = forced() || (!process.env.NO_COLOR && Boolean(process.stdout.isTTY) && Boolean(err.isTTY));

const paint = (code: string, close = '0') => (s: string) => (colorOn ? `\x1b[${code}m${s}\x1b[${close}m` : s);
export const c = {
  dim: paint('2', '22'),
  bold: paint('1', '22'),
  green: paint('32', '39'),
  red: paint('31', '39'),
  yellow: paint('33', '39'),
  blue: paint('34', '39'),
  cyan: paint('36', '39'),
  accent: paint('38;5;173', '39'), // Claude's terracotta, as close as 256 colours get
};

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BAR = 26;

function bar(fraction: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  const exact = f * BAR;
  const full = Math.floor(exact);
  const head = full < BAR ? (exact - full >= 0.5 ? '╸' : '') : '';
  const rest = BAR - full - (head ? 1 : 0);
  return c.accent('━'.repeat(full) + head) + c.dim('─'.repeat(rest));
}

export const secs = (ms: number) =>
  ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;

// ------------------------------------------------------------------ steps

let active: Task | null = null;
let timer: NodeJS.Timeout | null = null;
let frame = 0;

function startTimer(): void {
  if (timer || !live()) return;
  err.write('\x1b[?25l'); // hide the cursor while animating
  timer = setInterval(draw, 80);
  timer.unref();
}

function stopTimer(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  err.write('\x1b[?25h');
}

function draw(): void {
  if (!live() || !active || active.isSettled) return;
  err.write(`\r\x1b[2K${active.line(FRAMES[frame++ % FRAMES.length]!)}`);
}

export class Task {
  private readonly started = Date.now();
  private fraction: number | null = null;
  private settled = false;

  constructor(private label: string, private detail = '') {
    if (active && !active.settled) active.fail(`${active.label.replace(/…$/, '')}: interrupted`);
    active = this;
    startTimer();
    draw();
  }

  get isSettled(): boolean {
    return this.settled;
  }

  get elapsedMs(): number {
    return Date.now() - this.started;
  }

  /** New label and/or dim detail text after it (e.g. "ctrl+c to cancel"). */
  update(label: string, detail?: string): void {
    this.label = label;
    if (detail !== undefined) this.detail = detail;
  }

  /** done/total drive the bar; detail is the text after it (e.g. "12 / 73 files"). */
  progress(done: number, total: number, detail = ''): void {
    this.fraction = total > 0 ? done / total : null;
    this.detail = detail;
  }

  line(f: string): string {
    const parts = [`  ${c.accent(f)} ${this.label}`];
    if (this.fraction !== null) parts.push(bar(this.fraction));
    if (this.detail) parts.push(c.dim(this.detail));
    if (this.fraction === null && this.elapsedMs >= 2000) parts.push(c.dim(secs(this.elapsedMs)));
    return parts.join('  ');
  }

  succeed(text = this.label.replace(/…$/, '')): void {
    this.finish(`  ${c.green('✓')} ${text}  ${c.dim(secs(this.elapsedMs))}`);
  }

  /** A step that had nothing to do ("Already signed in"). */
  note(text = this.label.replace(/…$/, '')): void {
    this.finish(`  ${c.dim('·')} ${text}`);
  }

  warn(text = this.label.replace(/…$/, '')): void {
    this.finish(`  ${c.yellow('!')} ${text}`, true);
  }

  fail(text = this.label.replace(/…$/, '')): void {
    this.finish(`  ${c.red('✗')} ${text}`, true);
  }

  /** Remove the line without a result (e.g. nothing happened, or before a prompt). */
  clear(): void {
    if (this.settled) return;
    this.settled = true;
    if (active === this) {
      active = null;
      if (live()) err.write('\r\x1b[2K');
      stopTimer();
    }
  }

  private finish(text: string, important = false): void {
    if (this.settled) return;
    this.settled = true;
    if (!out.quiet || important) err.write(live() ? `\r\x1b[2K${text}\n` : `${text}\n`);
    if (active === this) {
      active = null;
      stopTimer();
    }
  }
}

export const task = (label: string, detail?: string) => new Task(label, detail);

// Run `fn` as one step; it succeeds unless fn settled it already.
export async function withTask<T>(label: string, fn: (t: Task) => Promise<T> | T, done?: (r: T) => string): Promise<T> {
  const t = task(label);
  try {
    const r = await fn(t);
    if (!t.isSettled) t.succeed(done ? done(r) : undefined);
    return r;
  } catch (e) {
    if (!t.isSettled) t.fail();
    throw e;
  }
}

function restoreCursor(): void {
  active?.clear();
  stopTimer();
}
process.on('exit', restoreCursor);

// Ctrl+C: run registered cleanups (newest first), then exit. Having a handler
// also means synchronous critical sections (file swaps) always run to the end.
const interruptHandlers: Array<() => Promise<void> | void> = [];
let interrupting = false;

export function onInterrupt(fn: () => Promise<void> | void): () => void {
  interruptHandlers.push(fn);
  return () => {
    const i = interruptHandlers.indexOf(fn);
    if (i >= 0) interruptHandlers.splice(i, 1);
  };
}

process.on('SIGINT', () => {
  if (interrupting) process.exit(130);
  interrupting = true;
  active?.warn('Cancelled');
  void (async () => {
    for (const fn of [...interruptHandlers].reverse()) {
      try {
        await fn();
      } catch (e) {
        err.write(`  ${c.red('✗')} Cleanup failed: ${(e as Error).message}. Run: claude-switch repair\n`);
      }
    }
    restoreCursor();
    process.exit(130);
  })();
});

// ------------------------------------------------------------------ messages

// Plain output (tables, results) goes to stdout, or stderr under --json.
// While a step is animating, messages are printed above it.
function write(line: string, stream: NodeJS.WriteStream = out.json ? err : process.stdout): void {
  if (out.quiet) return;
  if (active && live()) {
    err.write('\r\x1b[2K');
    stream.write(line + '\n');
    draw();
  } else {
    stream.write(line + '\n');
  }
}

export const say = (msg = '') => write(msg);
export const ok = (msg: string) => write(`  ${c.green('✓')} ${msg}`, err);
export const warn = (msg: string) => write(`  ${c.yellow('!')} ${msg}`, err);
export const info = (msg: string) => write(`  ${c.dim(msg)}`, err);

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function table(rows: string[][], header?: string[]): void {
  const all = header ? [header, ...rows] : rows;
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const widths = all[0]?.map((_, i) => Math.max(...all.map((r) => plain(r[i] ?? '').length))) ?? [];
  const fmt = (r: string[]) => r.map((cell, i) => cell + ' '.repeat((widths[i] ?? 0) - plain(cell).length)).join('  ').trimEnd();
  if (header) write(c.dim(fmt(header)));
  for (const r of rows) write(fmt(r));
}

// The closing line of a command, e.g. "Now using work  in 6.2s".
export function done(text: string, startedAt: number): void {
  write(`\n  ${c.green(text)}  ${c.dim(`in ${secs(Date.now() - startedAt)}`)}`, err);
}

// ------------------------------------------------------------------ input
// One shared line reader; works for typed and piped input.

let rl: readline.Interface | undefined;
let closed = false;
const pending: string[] = [];
const waiters: Array<(line: string | null) => void> = [];

function nextLine(): Promise<string | null> {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => (waiters.length ? waiters.shift()!(line) : pending.push(line)));
    rl.on('close', () => {
      closed = true;
      while (waiters.length) waiters.shift()!(null);
    });
  }
  if (pending.length) return Promise.resolve(pending.shift()!);
  if (closed) return Promise.resolve(null);
  return new Promise((r) => waiters.push(r));
}

export function closeInput(): void {
  rl?.close();
}

export async function prompt(question: string): Promise<string> {
  active?.clear();
  err.write(`  ${c.accent('?')} ${question} `);
  const line = await nextLine();
  if (line === null) throw new CdsError('No answer (input closed).', 'Pass --yes to run without prompts.');
  return line.trim();
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  if (out.yes) return true;
  const answer = (await prompt(`${question} ${c.dim(defaultYes ? '(Y/n)' : '(y/N)')}`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

export async function choose<T>(question: string, items: T[], label: (item: T) => string): Promise<T> {
  items.forEach((item, i) => write(`  ${c.accent(String(i + 1))}  ${label(item)}`, err));
  for (;;) {
    const answer = await prompt(`${question} (1-${items.length})`);
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1]!;
    warn(`Enter a number from 1 to ${items.length}.`);
  }
}
