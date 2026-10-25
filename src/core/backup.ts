import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context } from '../context.js';
import { CdsError } from '../errors.js';
import { copyPath, ensureDir, exists, isGuid, pathSize, readJson, readJsonOr, removePath, timestamp, walkFiles, writeFileAtomic, writeJsonAtomic } from '../util/fs.js';
import { parseSince } from '../util/time.js';
import { exportConfig } from './export.js';
import { createProfile, findByAccount, findProfile, listProfiles, writeProfile } from './profiles.js';
import { applyMerge, indexTranscripts, planMerge, readRecords, sessionRoot, transcriptRoot } from './sessions.js';

// A claude-switch backup is a folder that amber stores (encrypted, deduplicated):
//
//   .amber.json                       { "name": <amber project> }
//   claude-switch.json                what's inside: accounts and chats (no logins)
//   chats/session-indexes/<project>/local_<id>.json   sidebar records
//   chats/transcripts/<folder>/<cliId>.jsonl          transcripts (+ <cliId>/subagents)
//   config/                           `claude-switch export`, minus other accounts' sidebars
//
// Logins are never included: they only work on the PC that saved them. On a new PC,
// restore brings back everything else and `claude-switch setup` signs in once per account.

export const BACKUP_FORMAT = 'claude-switch-backup/1';

export interface Selection {
  /** Account ids to include; all when empty. */
  accounts?: string[];
  /** Only chats whose folder is inside one of these. */
  folders?: string[];
  /** Only chats active since, e.g. "30d". */
  since?: string;
  /** Session ids left out on purpose. */
  exclude?: string[];
}

export interface BackupSettings {
  project: string;
  selection: Selection;
  config: boolean;
}

export interface Chat {
  sessionId: string;
  cliSessionId: string;
  projectId: string;
  title: string;
  cwd: string;
  lastActivityAt: number;
  accounts: string[];
  indexPath: string;
  transcript: string | null;
  /** Transcript plus its subagent transcripts, in bytes. */
  bytes: number;
}

interface ManifestChat {
  sessionId: string;
  cliSessionId: string;
  projectId: string;
  title: string;
  cwd: string;
  lastActivityAt: number;
  accounts: string[];
  transcript: string | null; // relative to chats/transcripts
}

export interface BackupManifest {
  format: string;
  host: string;
  profiles: Array<{ name: string; accountUuid: string | null }>;
  chats: ManifestChat[];
  config: boolean;
}

// ------------------------------------------------------------------ settings

const settingsFile = (ctx: Context) => path.join(ctx.home.root, 'backup.json');

/** amber project names: letters, digits, dots, dashes, underscores. */
export const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

export function defaultProjectName(): string {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '');
  return host ? `claude-switch-${host}` : 'claude-switch';
}

export function loadSettings(ctx: Context): BackupSettings {
  const saved = readJsonOr<Partial<BackupSettings>>(settingsFile(ctx), {});
  return { project: saved.project ?? defaultProjectName(), selection: saved.selection ?? {}, config: saved.config ?? true };
}

export function saveSettings(ctx: Context, settings: BackupSettings): void {
  writeJsonAtomic(settingsFile(ctx), settings);
}

export function checkProjectName(name: string): string {
  if (!PROJECT_NAME.test(name)) {
    throw new CdsError(`"${name}" can't be an amber project name.`, 'Use letters, digits, dots, dashes and underscores, starting with a letter or digit.');
  }
  return name;
}

// ------------------------------------------------------------------ chats

/** Every Code chat on this PC, once each, with the accounts whose sidebar shows it. */
export function listChats(dataDir: string): Chat[] {
  const root = sessionRoot(dataDir);
  const transcripts = indexTranscripts([transcriptRoot()]);
  const byId = new Map<string, Chat>();
  let accounts: string[] = [];
  try {
    accounts = fs.readdirSync(root).filter(isGuid);
  } catch {
    return [];
  }
  for (const accountId of accounts) {
    for (const r of readRecords(path.join(root, accountId), accountId).records) {
      const key = `${r.projectId}|${r.sessionId}`;
      const cur = byId.get(key);
      if (cur) {
        if (!cur.accounts.includes(accountId)) cur.accounts.push(accountId);
        if (r.lastActivityAt <= cur.lastActivityAt) continue;
      }
      byId.set(key, {
        sessionId: r.sessionId,
        cliSessionId: r.cliSessionId,
        projectId: r.projectId,
        title: r.title,
        cwd: r.cwd,
        lastActivityAt: r.lastActivityAt,
        accounts: cur ? cur.accounts : [accountId],
        indexPath: r.path,
        transcript: transcripts.get(r.cliSessionId.toLowerCase()) ?? null,
        bytes: 0,
      });
    }
  }
  for (const ch of byId.values()) {
    if (ch.transcript) ch.bytes = pathSize(ch.transcript) + pathSize(path.join(path.dirname(ch.transcript), ch.cliSessionId));
  }
  return [...byId.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

export function inFolder(cwd: string, folder: string): boolean {
  const c = norm(cwd);
  const f = norm(folder);
  return c === f || c.startsWith(f + '\\');
}

export function applySelection(chats: Chat[], sel: Selection): Chat[] {
  const since = sel.since ? parseSince(sel.since).getTime() : null;
  const exclude = new Set(sel.exclude ?? []);
  return chats.filter((ch) =>
    (!sel.accounts?.length || ch.accounts.some((a) => sel.accounts!.includes(a)))
    && (!sel.folders?.length || sel.folders.some((f) => inFolder(ch.cwd, f)))
    && (since === null || ch.lastActivityAt >= since)
    && !exclude.has(ch.sessionId));
}

// ------------------------------------------------------------------ staging

interface StageFile {
  rel: string;
  /** Copy from here, keeping its timestamp (so amber sees unchanged files as unchanged). */
  src?: string;
  /** Or write this text. */
  text?: string;
  /** Compare by content instead of size + time (for regenerated files). */
  byContent?: boolean;
}

// Make `dir` hold exactly `files`, touching only what changed.
function syncFolder(dir: string, files: StageFile[]): { written: number; removed: number } {
  ensureDir(dir);
  const wanted = new Map(files.map((f) => [path.normalize(f.rel).toLowerCase(), f]));
  let removed = 0;
  for (const file of [...walkFiles(dir)]) {
    if (!wanted.has(path.relative(dir, file).toLowerCase())) {
      removePath(file);
      removed++;
    }
  }
  let written = 0;
  for (const f of files) {
    const dst = path.join(dir, f.rel);
    if (f.text !== undefined) {
      if (exists(dst) && fs.readFileSync(dst, 'utf8') === f.text) continue;
      writeFileAtomic(dst, f.text);
      written++;
      continue;
    }
    const st = fs.statSync(f.src!);
    if (exists(dst)) {
      const dt = fs.statSync(dst);
      if (f.byContent ? dt.size === st.size && fs.readFileSync(dst).equals(fs.readFileSync(f.src!))
        : dt.size === st.size && Math.abs(dt.mtimeMs - st.mtimeMs) < 2) continue;
    }
    ensureDir(path.dirname(dst));
    fs.copyFileSync(f.src!, dst);
    if (!f.byContent) fs.utimesSync(dst, st.atime, st.mtime);
    written++;
  }
  return { written, removed };
}

export const stageDir = (ctx: Context, project: string) => path.join(ctx.home.root, 'amber', project);

export interface StageResult {
  dir: string;
  project: string;
  chats: Chat[];
  missingTranscripts: number;
  accounts: string[];
  config: boolean;
  changed: number;
  /** The whole prepared folder, before compression. */
  bytes: number;
}

// Build the folder amber will back up.
export function stageBackup(ctx: Context, opts: { project: string; selection: Selection; config: boolean; onProgress?: (m: string) => void }): StageResult {
  const chats = applySelection(listChats(ctx.dataDir), opts.selection);
  const projects = transcriptRoot();
  const files: StageFile[] = [];
  const manifestChats: ManifestChat[] = [];
  for (const ch of chats) {
    files.push({ rel: path.join('chats', 'session-indexes', ch.projectId, `${ch.sessionId}.json`), src: ch.indexPath });
    let rel: string | null = null;
    if (ch.transcript) {
      rel = path.relative(projects, ch.transcript);
      files.push({ rel: path.join('chats', 'transcripts', rel), src: ch.transcript });
      // Subagent transcripts live next to it in <cliSessionId>/.
      const side = path.join(path.dirname(ch.transcript), ch.cliSessionId);
      for (const f of walkFiles(side)) files.push({ rel: path.join('chats', 'transcripts', path.relative(projects, f)), src: f });
    }
    manifestChats.push({
      sessionId: ch.sessionId, cliSessionId: ch.cliSessionId, projectId: ch.projectId, title: ch.title, cwd: ch.cwd,
      lastActivityAt: ch.lastActivityAt, accounts: [...ch.accounts].sort(), transcript: rel && rel.split(path.sep).join('/'),
    });
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    host: os.hostname(),
    profiles: listProfiles(ctx.home).map((p) => ({ name: p.name, accountUuid: p.accountUuid })),
    chats: manifestChats,
    config: opts.config,
  };
  files.push({ rel: 'claude-switch.json', text: JSON.stringify(manifest, null, 2) + '\n' });
  files.push({ rel: '.amber.json', text: JSON.stringify({ name: opts.project }, null, 2) + '\n' });
  files.push({ rel: 'README.txt', text: README });

  if (opts.config) {
    const tmp = path.join(ctx.home.root, 'tmp', `export-${process.pid}`);
    removePath(tmp);
    try {
      exportConfig({
        outDir: tmp, dataDir: ctx.dataDir, includeTranscripts: false, sidebars: false, inventory: false,
        profileName: (id) => findByAccount(ctx.home, id)?.name ?? null,
        onProgress: opts.onProgress,
      });
      // The export's README and log carry the time of the run; leave them out so an
      // unchanged config stays byte-for-byte unchanged.
      const skip = new Set(['readme.txt', 'export-log.txt']);
      for (const f of walkFiles(tmp)) {
        const rel = path.relative(tmp, f);
        if (!skip.has(rel.toLowerCase())) files.push({ rel: path.join('config', rel), src: f, byContent: true });
      }
      const dir = stageDir(ctx, opts.project);
      const r = syncFolder(dir, files);
      return result(dir, r.written + r.removed);
    } finally {
      removePath(tmp);
    }
  }
  const dir = stageDir(ctx, opts.project);
  const r = syncFolder(dir, files);
  return result(dir, r.written + r.removed);

  function result(dir: string, changed: number): StageResult {
    return {
      dir, project: opts.project, chats, changed, config: opts.config, bytes: pathSize(dir),
      missingTranscripts: chats.filter((c) => !c.transcript).length,
      accounts: [...new Set(chats.flatMap((c) => c.accounts))],
    };
  }
}

const README = `This folder is a claude-switch backup, stored with amber.

claude-switch.json   which accounts and chats are inside
chats/               Code-tab chats: sidebar records and transcripts
config/              Claude settings, memory, skills and MCP config (secrets blanked out)

Logins are never included. On a new PC:
  amber login
  claude-switch restore
  claude-switch setup
`;

// ------------------------------------------------------------------ restore

export type PathMap = Array<[from: string, to: string]>;

export function parseMaps(values: string[] = []): PathMap {
  return values.map((v) => {
    const i = v.indexOf('=');
    if (i <= 0 || i === v.length - 1) throw new CdsError(`Invalid --map "${v}".`, 'Use --map OLD=NEW, e.g. --map C:\\Users\\old=C:\\Users\\new');
    return [v.slice(0, i), v.slice(i + 1)] as [string, string];
  });
}

export function mapPath(p: string, maps: PathMap): string {
  for (const [from, to] of maps) {
    if (inFolder(p, from)) return to.replace(/[\\/]+$/, '') + p.slice(from.replace(/[\\/]+$/, '').length);
  }
  return p;
}

// Claude Code names a transcript folder after the working folder: every character that isn't
// a letter or digit becomes "-".
export const encodeFolder = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');

export function mapTranscriptPath(rel: string, maps: PathMap): string {
  const [dir, ...rest] = rel.split(/[\\/]/);
  if (!dir) return rel;
  for (const [from, to] of maps) {
    const ef = encodeFolder(from.replace(/[\\/]+$/, ''));
    if (dir.toLowerCase().startsWith(ef.toLowerCase())) return [encodeFolder(to.replace(/[\\/]+$/, '')) + dir.slice(ef.length), ...rest].join(path.sep);
  }
  return rel.split(/[\\/]/).join(path.sep);
}

export const pendingDir = (ctx: Context, accountId: string) => path.join(ctx.home.root, 'pending', accountId);

export interface RestoreResult {
  from: string;
  host: string;
  profilesAdded: string[];
  transcripts: { restored: number; kept: number };
  chats: number;
  appliedTo: string[];
  waitingFor: string[];
  configDir: string | null;
}

// Unpack a backup that amber restored into `dir`. Logins are not part of it.
export function restoreFromFolder(ctx: Context, dir: string, maps: PathMap, opts: { chats: boolean }): Omit<RestoreResult, 'appliedTo' | 'from'> {
  const file = path.join(dir, 'claude-switch.json');
  if (!exists(file)) throw new CdsError('That amber project is not a claude-switch backup (no claude-switch.json).');
  const manifest = readJson<BackupManifest>(file);
  if (manifest.format !== BACKUP_FORMAT) {
    throw new CdsError(`This backup was made by a newer claude-switch (${manifest.format}).`, 'Update claude-switch and try again.');
  }

  // Accounts come back as profiles waiting for a sign-in.
  const profilesAdded: string[] = [];
  for (const p of manifest.profiles) {
    if (!p.accountUuid || findByAccount(ctx.home, p.accountUuid)) continue;
    let name = p.name;
    for (let i = 2; findProfile(ctx.home, name); i++) name = `${p.name}-${i}`;
    const profile = createProfile(ctx.home, name, p.accountUuid);
    profile.status = 'needs-login';
    writeProfile(ctx.home, profile);
    profilesAdded.push(name);
  }

  let restored = 0;
  let kept = 0;
  const waiting = new Set<string>();
  if (opts.chats) {
    const src = path.join(dir, 'chats', 'transcripts');
    for (const f of walkFiles(src)) {
      const dst = path.join(transcriptRoot(), mapTranscriptPath(path.relative(src, f), maps));
      // Transcripts only ever grow: a longer local copy is the newer one.
      if (exists(dst) && fs.statSync(dst).size >= fs.statSync(f).size) {
        kept++;
        continue;
      }
      copyPath(f, dst);
      restored++;
    }
    // Sidebar records wait per account until that account is set up on this PC.
    for (const ch of manifest.chats) {
      const index = path.join(dir, 'chats', 'session-indexes', ch.projectId, `${ch.sessionId}.json`);
      if (!exists(index)) continue;
      const record = readJson<Record<string, unknown>>(index);
      for (const key of ['cwd', 'originCwd']) {
        if (typeof record[key] === 'string') record[key] = mapPath(record[key] as string, maps);
      }
      for (const account of ch.accounts) {
        writeJsonAtomic(path.join(pendingDir(ctx, account), 'session-indexes', ch.projectId, `${ch.sessionId}.json`), record, 0);
        waiting.add(account);
      }
    }
  }

  let configDir: string | null = null;
  if (manifest.config && exists(path.join(dir, 'config'))) configDir = path.join(dir, 'config');
  return {
    host: manifest.host,
    profilesAdded,
    transcripts: { restored, kept },
    chats: opts.chats ? manifest.chats.length : 0,
    waitingFor: [...waiting],
    configDir,
  };
}

export function accountsWithPending(ctx: Context): string[] {
  try {
    return fs.readdirSync(path.join(ctx.home.root, 'pending')).filter(isGuid);
  } catch {
    return [];
  }
}

export function hasSidebar(ctx: Context, accountId: string): boolean {
  return exists(path.join(sessionRoot(ctx.dataDir), accountId));
}

// Put an account's waiting chats into its sidebar. Claude Desktop must be closed.
// Chats deleted on this PC stay deleted; a newer local copy wins.
export function applyPending(ctx: Context, accountId: string): { added: number; updated: number } {
  const dir = pendingDir(ctx, accountId);
  if (!exists(dir)) return { added: 0, updated: 0 };
  const plan = planMerge(ctx.dataDir, accountId, { vaultDir: ctx.home.vault, extraVaults: [dir], vaultsOnly: true, createProjects: true });
  const r = plan.items.length ? applyMerge(ctx.dataDir, plan, ctx.home.vault, ctx.home.backups) : { added: 0, updated: 0 };
  removePath(dir);
  return { added: r.added, updated: r.updated };
}

export const restoreWorkDir = (ctx: Context) => path.join(ctx.home.root, 'restores', timestamp());
