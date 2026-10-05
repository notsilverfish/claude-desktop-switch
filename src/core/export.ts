import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, exists, pathSize, readJsonOr, walkFiles, writeFileAtomic } from '../util/fs.js';
import { claudeHome, listAccounts, readRecords, sessionRoot, transcriptRoot } from './sessions.js';

// A redacted snapshot of Claude configuration for backup or moving to another PC:
// Claude Code settings, CLAUDE.md, memory, skills/agents/commands, plugin and MCP
// config, Desktop config and extension manifests, Code sidebar records, per-project
// config. Never includes logins: no config.json, cookies, browser storage, saved
// profiles, .credentials.json, keys or certificates.

// ------------------------------------------------------------------ redaction

const PATTERNS: Array<[RegExp, string]> = [
  [/("[^"\r\n]*(token|secret|password|passwd|api[_-]?key|apikey|authorization|bearer|credential|private[_-]?key|access[_-]?key|client[_-]?secret|service[_-]?role)[^"\r\n]*"\s*:\s*")([^"\r\n]{4,})(")/gi, '$1<REDACTED:KEYVALUE>$4'],
  [/\b([A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|_PAT)[A-Z0-9_]*[ \t]*[=:][ \t]*)(["']?)(?!<REDACTED)(?=[A-Za-z0-9_\-+/=.]*[0-9])(?=[A-Za-z0-9_\-+/=.]*[A-Za-z])([A-Za-z0-9_\-+/=.]{16,})/g, '$1$3<REDACTED:ENV>'],
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, '<REDACTED:ANTHROPIC_KEY>'],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{20,}/g, '<REDACTED:OPENAI_KEY>'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '<REDACTED:GITHUB_TOKEN>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '<REDACTED:GITHUB_PAT>'],
  [/\bsbp_[A-Za-z0-9]{20,}/g, '<REDACTED:SUPABASE_PAT>'],
  [/\bsb_secret_[A-Za-z0-9_-]{10,}/g, '<REDACTED:SUPABASE_SECRET>'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '<REDACTED:SLACK_TOKEN>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<REDACTED:AWS_KEY>'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '<REDACTED:GOOGLE_KEY>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<REDACTED:JWT>'],
  [/(bearer\s+)[A-Za-z0-9_\-.=]{16,}/gi, '$1<REDACTED:BEARER>'],
  [/((postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^:/\s"@]+:)([^@\s"]+)(@)/gi, '$1<REDACTED:DB_PASSWORD>$6'],
];

export function redact(text: string): { text: string; count: number } {
  let count = 0;
  for (const [re, rep] of PATTERNS) {
    count += text.match(re)?.length ?? 0;
    text = text.replace(re, rep);
  }
  return { text, count };
}

const TEXT_EXT = new Set(['.json', '.jsonl', '.md', '.txt', '.yaml', '.yml', '.toml', '.ps1', '.sh', '.js', '.ts', '.py', '.cmd', '.bat', '.env', '.ini', '.cfg', '.idx', '']);
const MAX_TEXT = 200 * 1024 * 1024;
const NEVER = /(^\.credentials|\.key$|\.pem$|\.p12$|\.pfx$)/i;

export interface ExportOptions {
  outDir: string;
  dataDir: string | null;
  includeTranscripts: boolean;
  profileName: (accountId: string) => string | null;
  onProgress?: (message: string) => void;
}

export interface ExportResult {
  outDir: string;
  files: number;
  bytes: number;
  redactions: number;
  skipped: string[];
  log: string[];
}

export function exportConfig(opts: ExportOptions): ExportResult {
  const out = ensureDir(opts.outDir);
  const result: ExportResult = { outDir: out, files: 0, bytes: 0, redactions: 0, skipped: [], log: [] };
  const note = (m: string) => {
    result.log.push(m);
    opts.onProgress?.(m);
  };

  const copyFile = (src: string, dst: string) => {
    if (NEVER.test(path.basename(src))) return;
    try {
      ensureDir(path.dirname(dst));
      const ext = path.extname(src).toLowerCase();
      const size = fs.statSync(src).size;
      if (TEXT_EXT.has(ext) && size < MAX_TEXT) {
        const r = redact(fs.readFileSync(src, 'utf8'));
        result.redactions += r.count;
        fs.writeFileSync(dst, r.text);
      } else {
        fs.copyFileSync(src, dst);
      }
      result.files++;
      result.bytes += size;
    } catch (e) {
      result.skipped.push(`${src}: ${(e as Error).message}`);
    }
  };
  const copyTree = (src: string, dst: string): number => {
    if (!exists(src)) return 0;
    let n = 0;
    for (const f of walkFiles(src)) {
      copyFile(f, path.join(dst, path.relative(src, f)));
      n++;
    }
    return n;
  };
  const writeJson = (rel: string, value: unknown) => {
    const r = redact(JSON.stringify(value, null, 2));
    result.redactions += r.count;
    writeFileAtomic(path.join(out, rel), r.text);
    result.files++;
  };

  // 1. ~/.claude
  const ch = claudeHome();
  const cc = path.join(out, 'dot-claude');
  if (exists(ch)) {
    for (const name of ['settings.json', 'settings.local.json', 'CLAUDE.md', 'keybindings.json', 'statusline.sh', 'statusline.ps1']) {
      if (exists(path.join(ch, name))) copyFile(path.join(ch, name), path.join(cc, name));
    }
    for (const dir of ['agents', 'commands', 'skills', 'output-styles', 'hooks', 'rules']) {
      const n = copyTree(path.join(ch, dir), path.join(cc, dir));
      if (n) note(`~/.claude/${dir}: ${n} files`);
    }
    const plugins = path.join(ch, 'plugins');
    if (exists(plugins)) {
      for (const e of fs.readdirSync(plugins, { withFileTypes: true })) {
        if (e.isFile()) copyFile(path.join(plugins, e.name), path.join(cc, 'plugins', e.name));
      }
      for (const f of walkFiles(plugins)) {
        if (['marketplace.json', 'plugin.json'].includes(path.basename(f))) {
          copyFile(f, path.join(cc, 'plugins', 'manifests', path.relative(plugins, f)));
        }
      }
      note('plugin and marketplace manifests');
    }
    const inventory: Array<{ path: string; bytes: number; modified: string }> = [];
    const projects = transcriptRoot();
    if (exists(projects)) {
      for (const p of fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory())) {
        const n = copyTree(path.join(projects, p.name, 'memory'), path.join(cc, 'projects', p.name, 'memory'));
        if (n) note(`memory for ${p.name}: ${n} files`);
      }
      for (const f of walkFiles(projects)) {
        if (!f.endsWith('.jsonl')) continue;
        const st = fs.statSync(f);
        const rel = path.relative(projects, f);
        inventory.push({ path: rel, bytes: st.size, modified: st.mtime.toISOString() });
        if (opts.includeTranscripts) copyFile(f, path.join(out, 'transcripts', rel));
      }
    }
    writeJson('transcript-inventory.json', inventory);
    note(`${inventory.length} transcripts ${opts.includeTranscripts ? 'copied (redacted)' : 'listed (use --include-transcripts to copy them)'}`);
  } else {
    note('~/.claude not found');
  }

  // 2. ~/.claude.json: MCP servers and per-project tool settings only
  const cj = readJsonOr<Record<string, unknown> | null>(path.join(os.homedir(), '.claude.json'), null);
  if (cj) {
    const keep: Record<string, unknown> = {};
    for (const k of ['mcpServers', 'enabledPlugins', 'theme', 'preferredNotifChannel', 'autoUpdates', 'editorMode']) {
      if (k in cj) keep[k] = cj[k];
    }
    const projects: Record<string, unknown> = {};
    for (const [dir, cfg] of Object.entries((cj.projects ?? {}) as Record<string, Record<string, unknown>>)) {
      const e: Record<string, unknown> = {};
      for (const k of ['mcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'allowedTools', 'mcpContextUris', 'hasTrustDialogAccepted']) {
        if (k in cfg) e[k] = cfg[k];
      }
      projects[dir] = e;
    }
    keep.projects = projects;
    writeJson('dot-claude-json.filtered.json', keep);
    note('~/.claude.json (MCP servers and per-project tool settings only)');
  }

  // 3. Claude Desktop
  const cwds = new Set<string>();
  if (opts.dataDir && exists(opts.dataDir)) {
    const dk = path.join(out, 'claude-desktop');
    for (const name of ['claude_desktop_config.json', 'extensions-installations.json', 'extensions-blocklist.json', 'mcp-user-tool-toggles.json', 'git-worktrees.json']) {
      if (exists(path.join(opts.dataDir, name))) copyFile(path.join(opts.dataDir, name), path.join(dk, name));
    }
    const ext = path.join(opts.dataDir, 'Claude Extensions');
    if (exists(ext)) {
      for (const f of walkFiles(ext)) {
        const rel = path.relative(ext, f);
        if (path.basename(f) === 'manifest.json' && rel.split(path.sep).length <= 3) copyFile(f, path.join(dk, 'Claude Extensions', rel));
      }
      note('desktop extension manifests');
    }
    const cowork = copyTree(path.join(opts.dataDir, 'local-agent-mode-sessions'), path.join(dk, 'local-agent-mode-sessions'));
    if (cowork) note(`Cowork sessions: ${cowork} files (redacted)`);
    copyTree(path.join(opts.dataDir, 'Claude Extensions Settings'), path.join(dk, 'Claude Extensions Settings'));

    const sessions = copyTree(sessionRoot(opts.dataDir), path.join(dk, 'claude-code-sessions'));
    const accounts = listAccounts(opts.dataDir);
    for (const a of accounts) {
      for (const r of readRecords(path.join(sessionRoot(opts.dataDir), a.accountId), a.accountId).records) if (r.cwd) cwds.add(r.cwd);
    }
    note(`Code sidebar records: ${sessions} files across ${accounts.length} accounts`);

    const inventory = fs.readdirSync(opts.dataDir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      dir: e.isDirectory(),
      bytes: pathSize(path.join(opts.dataDir!, e.name)),
    }));
    writeJson(path.join('claude-desktop', 'accounts-and-inventory.json'), {
      accounts: accounts.map((a) => ({ ...a, profile: opts.profileName(a.accountId) })),
      dataFolderInventory: inventory,
    });
  } else {
    note('Claude Desktop data folder not found; skipped');
  }

  // 4. Per-project config for every folder that has Code chats
  const projectsOut: Array<{ cwd: string; exists: boolean; gitRemotes: string; folder: string }> = [];
  for (const cwd of cwds) {
    const folder = cwd.replace(/[:\\/ ]+/g, '_').replace(/^_+|_+$/g, '');
    const present = exists(cwd);
    let gitRemotes = '';
    if (present) {
      for (const name of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.mcp.json', 'README.md', 'package.json']) {
        if (exists(path.join(cwd, name))) copyFile(path.join(cwd, name), path.join(out, 'project-config', folder, name));
      }
      for (const name of ['settings.json', 'settings.local.json']) {
        const p = path.join(cwd, '.claude', name);
        if (exists(p)) copyFile(p, path.join(out, 'project-config', folder, '.claude', name));
      }
      for (const dir of ['agents', 'commands', 'skills', 'rules']) {
        copyTree(path.join(cwd, '.claude', dir), path.join(out, 'project-config', folder, '.claude', dir));
      }
      try {
        const git = fs.readFileSync(path.join(cwd, '.git', 'config'), 'utf8');
        gitRemotes = [...git.matchAll(/url\s*=\s*(\S+)/g)].map((m) => m[1]!.replace(/:\/\/[^@/\s]+@/, '://')).join(' ');
      } catch {
        // not a git repo
      }
    }
    projectsOut.push({ cwd, exists: present, gitRemotes, folder });
  }
  writeJson(path.join('project-config', 'projects.json'), projectsOut);
  note(`project config for ${cwds.size} folders`);

  writeFileAtomic(path.join(out, 'export-log.txt'), result.log.join('\n') + '\n');
  writeFileAtomic(path.join(out, 'README.txt'), [
    'Claude configuration export (claude-desktop-switch)',
    `Created: ${new Date().toISOString()}`,
    '',
    'Secrets found in text files were replaced with <REDACTED:...>.',
    'Logins are never included: no tokens, cookies, browser storage or saved profiles.',
    opts.includeTranscripts ? 'transcripts/ contains your chat history (redacted). Keep this folder private.' : '',
  ].join('\n'));
  return result;
}
