import { execFileSync } from 'node:child_process';

// Runs a PowerShell snippet and returns its stdout (UTF-8, trimmed).
export function runPowerShell(script: string, timeoutMs = 30000): string {
  return execFileSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  ).trim();
}

// Single-quoted PowerShell string literal.
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
