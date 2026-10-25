import fs from 'node:fs';
import path from 'node:path';
import { CdsError } from '../errors.js';
import { runPowerShell } from './powershell.js';

export interface Install {
  kind: 'store' | 'installer' | 'fake';
  version: string | null;
  /** Folder containing Claude.exe. */
  installDir: string | null;
  exe: string | null;
  /** Microsoft Store package family, e.g. Claude_pzs8sxrjxfjjc. */
  family: string | null;
}

export interface DataDir {
  dir: string;
  source: 'override' | 'claude-data' | 'store' | 'appdata';
}

export const fakeMode = () => process.env.CDS_FAKE_PROCESSES === '1';

let cached: Install | null | undefined;

export function detectInstall(): Install | null {
  if (cached !== undefined) return cached;
  if (fakeMode()) {
    return (cached = { kind: 'fake', version: 'test', installDir: null, exe: null, family: null });
  }
  cached = detectStore() ?? detectInstaller();
  return cached;
}

export function requireInstall(): Install {
  const install = detectInstall();
  if (!install) {
    throw new CdsError('Claude Desktop is not installed.', 'Install it from https://claude.ai/download and sign in once.');
  }
  return install;
}

function detectStore(): Install | null {
  let raw = '';
  try {
    raw = runPowerShell(
      "$p = Get-AppxPackage -Name 'Claude' | Sort-Object Version -Descending | Select-Object -First 1; " +
      'if ($p) { @{ family = $p.PackageFamilyName; location = $p.InstallLocation; version = [string]$p.Version } | ConvertTo-Json -Compress }',
    );
  } catch {
    return null;
  }
  if (!raw) return null;
  const p = JSON.parse(raw) as { family: string; location: string; version: string };
  return {
    kind: 'store',
    version: p.version,
    installDir: path.join(p.location, 'app'),
    exe: path.join(p.location, 'app', 'Claude.exe'),
    family: p.family,
  };
}

// The classic installer (Squirrel) puts a launcher stub in %LOCALAPPDATA%\AnthropicClaude
// and the real app in app-<version> folders next to it.
function detectInstaller(): Install | null {
  const root = path.join(process.env.LOCALAPPDATA ?? '', 'AnthropicClaude');
  const stub = path.join(root, 'claude.exe');
  if (!fs.existsSync(stub)) return null;
  const versions = fs.readdirSync(root)
    .filter((d) => /^app-\d/.test(d))
    .map((d) => d.slice(4))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { kind: 'installer', version: versions.at(-1) ?? null, installDir: root, exe: stub, family: null };
}

// Store installs keep the real data in the package's LocalCache. %APPDATA%\Claude
// is only a projection of it while the app runs; when the app is closed that path
// shows a different, nearly empty folder. Always prefer the package folder.
export function dataDirCandidates(override?: string): DataDir[] {
  const list: DataDir[] = [];
  const forced = override ?? process.env.CDS_DATA;
  if (forced) return [{ dir: path.resolve(forced), source: 'override' }];
  // Claude Desktop 3.x keeps its data in %LOCALAPPDATA%\Claude-Data\claude_<package id>.
  const claudeData = path.join(process.env.LOCALAPPDATA ?? '', 'Claude-Data');
  try {
    for (const name of fs.readdirSync(claudeData)) {
      if (name.toLowerCase().startsWith('claude')) list.push({ dir: path.join(claudeData, name), source: 'claude-data' });
    }
  } catch {
    // older version: no Claude-Data folder
  }
  const packages = path.join(process.env.LOCALAPPDATA ?? '', 'Packages');
  try {
    for (const name of fs.readdirSync(packages)) {
      if (name.startsWith('Claude_')) {
        list.push({ dir: path.join(packages, name, 'LocalCache', 'Roaming', 'Claude'), source: 'store' });
      }
    }
  } catch {
    // no Packages folder
  }
  list.push({ dir: path.join(process.env.APPDATA ?? '', 'Claude'), source: 'appdata' });
  return list;
}

// Claude has moved its data folder between versions (2.x: the Store package's
// LocalCache; 3.x: %LOCALAPPDATA%\Claude-Data). An update can leave the old folder
// behind, so when several exist, use the one Claude wrote to most recently.
export function resolveDataDir(override?: string): DataDir {
  const candidates = dataDirCandidates(override);
  const lastWrite = (c: DataDir) => {
    try {
      return fs.statSync(path.join(c.dir, 'config.json')).mtimeMs;
    } catch {
      return -1;
    }
  };
  const found = candidates
    .map((c) => ({ c, t: lastWrite(c) }))
    .filter((x) => x.t >= 0)
    .sort((a, b) => b.t - a.t)[0]?.c;
  if (!found) {
    throw new CdsError(
      `Claude Desktop data folder not found (looked in ${candidates.map((c) => c.dir).join(', ')}).`,
      'Open Claude Desktop and sign in once, or pass --data-dir.',
    );
  }
  return found;
}
