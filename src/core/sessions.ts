import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyPath, ensureDir, exists, isGuid, readJson, readJsonOr, timestamp, walkFiles, writeJsonAtomic } from '../util/fs.js';

// Claude Desktop's Code-tab sidebar, per account:
//   <data>/claude-code-sessions/<accountId>/<projectId>/local_<id>.json   one record per chat
//   .../deleted_<id>             the user deleted that chat (contains a timestamp)
//   .../archived-sessions.idx    {"v":1,"archived":["local_<id>", ...]}
// Transcripts are shared by all accounts: ~/.claude/projects/**/<cliSessionId>.jsonl

export interface SessionRecord {
  accountId: string; // or 'vault:<path>' for preserved copies
  projectId: string;
  sessionId: string; // local_<guid>
  cliSessionId: string;
  title: string;
  cwd: string;
  lastActivityAt: number;
  archived: boolean;
  path: string;
}

export interface AccountSessions {
  accountId: string;
  projects: string[];
  chats: number;
  deleted: number;
  lastActivityAt: number;
}

const SESSION_ID = /^local_[0-9a-f-]{36}$/i;

export const sessionRoot = (dataDir: string) => path.join(dataDir, 'claude-code-sessions');
export const claudeHome = () => process.env.CDS_CLAUDE_HOME ?? path.join(os.homedir(), '.claude');
export const transcriptRoot = () => path.join(claudeHome(), 'projects');

function readArchived(projectDir: string): Set<string> {
  const idx = readJsonOr<{ archived?: unknown }>(path.join(projectDir, 'archived-sessions.idx'), {});
  return new Set(Array.isArray(idx.archived) ? idx.archived.filter((x): x is string => typeof x === 'string') : []);
}

function deletedIds(projectDir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(projectDir).filter((n) => n.startsWith('deleted_')).map((n) => `local_${n.slice(8)}`));
  } catch {
    return new Set();
  }
}

function dirs(p: string): string[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// Reads the records in one <accountId> (or vault) folder. Records the user deleted
// in that same folder are left out. Malformed files are counted, not fatal.
export function readRecords(accountDir: string, accountId: string): { records: SessionRecord[]; invalid: number } {
  const records: SessionRecord[] = [];
  let invalid = 0;
  for (const projectId of dirs(accountDir).filter(isGuid)) {
    const projectDir = path.join(accountDir, projectId);
    const archived = readArchived(projectDir);
    const deleted = deletedIds(projectDir);
    for (const name of fs.readdirSync(projectDir)) {
      if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
      const file = path.join(projectDir, name);
      try {
        const m = readJson<Record<string, unknown>>(file);
        const sessionId = String(m.sessionId ?? '');
        const cliSessionId = String(m.cliSessionId ?? '');
        if (!SESSION_ID.test(sessionId) || !isGuid(cliSessionId) || name !== `${sessionId}.json`) {
          invalid++;
          continue;
        }
        if (deleted.has(sessionId)) continue;
        records.push({
          accountId,
          projectId,
          sessionId,
          cliSessionId,
          title: typeof m.title === 'string' && m.title ? m.title : '(untitled)',
          cwd: typeof m.cwd === 'string' ? m.cwd : '',
          lastActivityAt: Number(m.lastActivityAt ?? 0) || 0,
          archived: archived.has(sessionId) || m.isArchived === true,
          path: file,
        });
      } catch {
        invalid++;
      }
    }
  }
  return { records, invalid };
}

export function listAccounts(dataDir: string): AccountSessions[] {
  const root = sessionRoot(dataDir);
  return dirs(root).filter(isGuid).map((accountId) => {
    const accountDir = path.join(root, accountId);
    const projects = dirs(accountDir).filter(isGuid);
    const { records } = readRecords(accountDir, accountId);
    const deleted = projects.reduce((n, p) => n + deletedIds(path.join(accountDir, p)).size, 0);
    return {
      accountId,
      projects,
      chats: records.length,
      deleted,
      lastActivityAt: Math.max(0, ...records.map((r) => r.lastActivityAt)),
    };
  }).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

export function indexTranscripts(roots: string[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const root of roots) {
    for (const file of walkFiles(root)) {
      const base = path.basename(file, '.jsonl');
      if (file.endsWith('.jsonl') && isGuid(base) && !byId.has(base.toLowerCase())) byId.set(base.toLowerCase(), file);
    }
  }
  return byId;
}

// ------------------------------------------------------------------ merge

export interface MergePlanItem {
  record: SessionRecord;
  action: 'add' | 'update';
  hasTranscript: boolean;
}

export interface MergePlan {
  activeAccountId: string;
  items: MergePlanItem[];
  alreadyPresent: number;
  deletedHere: number; // deleted by the user in the active account: never brought back
  missingProject: Map<string, string>; // projectId -> a cwd, for projects not opened in this account
  invalid: number;
}

export interface MergeOptions {
  /** Account ids to take chats from; all other accounts when omitted. */
  from?: string[];
  /** Extra vault roots to recover chats from (e.g. the old merger's Vault folder). */
  extraVaults?: string[];
  vaultDir: string;
  /** Take chats only from `extraVaults` (a restore), not from other accounts or the vault. */
  vaultsOnly?: boolean;
  /** Create a missing project folder instead of skipping its chats (restoring onto a new PC). */
  createProjects?: boolean;
}

function newest(records: SessionRecord[]): SessionRecord[] {
  const best = new Map<string, SessionRecord>();
  for (const r of records) {
    const key = `${r.projectId}|${r.sessionId}`;
    const cur = best.get(key);
    if (!cur || r.lastActivityAt > cur.lastActivityAt) best.set(key, r);
  }
  return [...best.values()];
}

export function planMerge(dataDir: string, activeAccountId: string, opts: MergeOptions): MergePlan {
  const root = sessionRoot(dataDir);
  const activeDir = path.join(root, activeAccountId);
  const sources: SessionRecord[] = [];
  let invalid = 0;
  const accounts = opts.vaultsOnly ? [] : dirs(root).filter(isGuid).filter((a) => a !== activeAccountId && (!opts.from || opts.from.includes(a)));
  for (const a of accounts) {
    const r = readRecords(path.join(root, a), a);
    sources.push(...r.records);
    invalid += r.invalid;
  }
  const vaults = opts.vaultsOnly ? (opts.extraVaults ?? []) : [opts.vaultDir, ...(opts.extraVaults ?? [])];
  if (!opts.from) {
    for (const v of vaults) {
      const indexes = path.join(v, 'session-indexes');
      if (exists(indexes)) sources.push(...readRecords(indexes, `vault:${v}`).records);
    }
  }
  const transcripts = indexTranscripts([transcriptRoot(), ...vaults.map((v) => path.join(v, 'transcripts'))]);

  const activeProjects = new Set(dirs(activeDir).filter(isGuid));
  const deletedByProject = new Map([...activeProjects].map((p) => [p, deletedIds(path.join(activeDir, p))]));
  const plan: MergePlan = { activeAccountId, items: [], alreadyPresent: 0, deletedHere: 0, missingProject: new Map(), invalid };

  for (const record of newest(sources)) {
    if (!activeProjects.has(record.projectId) && !opts.createProjects) {
      if (!plan.missingProject.has(record.projectId)) plan.missingProject.set(record.projectId, record.cwd);
      continue;
    }
    if (deletedByProject.get(record.projectId)?.has(record.sessionId)) {
      plan.deletedHere++;
      continue;
    }
    const dest = path.join(activeDir, record.projectId, `${record.sessionId}.json`);
    const hasTranscript = transcripts.has(record.cliSessionId.toLowerCase());
    if (!exists(dest)) {
      plan.items.push({ record, action: 'add', hasTranscript });
      continue;
    }
    const current = Number(readJsonOr<{ lastActivityAt?: number }>(dest, {}).lastActivityAt ?? 0);
    if (record.lastActivityAt > current) plan.items.push({ record, action: 'update', hasTranscript });
    else plan.alreadyPresent++;
  }
  plan.items.sort((a, b) => b.record.lastActivityAt - a.record.lastActivityAt);
  return plan;
}

export interface MergeResult {
  added: number;
  updated: number;
  backupDir: string;
  vaulted: { indexes: number; transcripts: number };
}

// Apply a plan. Claude Desktop must be closed (it rewrites these files).
export function applyMerge(dataDir: string, plan: MergePlan, vaultDir: string, backupsDir: string): MergeResult {
  const activeDir = path.join(sessionRoot(dataDir), plan.activeAccountId);
  const backupDir = path.join(backupsDir, `${timestamp()}-sessions-${plan.activeAccountId.slice(0, 8)}`);
  copyPath(activeDir, backupDir);

  let added = 0;
  let updated = 0;
  const archivedByProject = new Map<string, string[]>();
  for (const { record, action } of plan.items) {
    const dest = path.join(activeDir, record.projectId, `${record.sessionId}.json`);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(record.path, dest);
    if (action === 'add') added++;
    else updated++;
    if (record.archived) {
      const list = archivedByProject.get(record.projectId) ?? [];
      list.push(record.sessionId);
      archivedByProject.set(record.projectId, list);
    }
  }
  // Keep archived chats archived in the destination too.
  for (const [projectId, ids] of archivedByProject) {
    const idxFile = path.join(activeDir, projectId, 'archived-sessions.idx');
    const idx = readJsonOr<{ v?: number; archived?: string[] }>(idxFile, { v: 1, archived: [] });
    const set = new Set([...(idx.archived ?? []), ...ids]);
    writeJsonAtomic(idxFile, { ...idx, v: idx.v ?? 1, archived: [...set] }, 0);
  }
  return { added, updated, backupDir, vaulted: vaultAll(dataDir, vaultDir) };
}

// Keep copies of every sidebar record and its transcript, so chats survive even
// if Claude later removes an old account's folder.
export function vaultAll(dataDir: string, vaultDir: string): { indexes: number; transcripts: number } {
  const root = sessionRoot(dataDir);
  const records: SessionRecord[] = [];
  for (const a of dirs(root).filter(isGuid)) records.push(...readRecords(path.join(root, a), a).records);
  const transcripts = indexTranscripts([transcriptRoot()]);
  let indexes = 0;
  let copied = 0;
  for (const r of newest(records)) {
    const dest = path.join(vaultDir, 'session-indexes', r.projectId, `${r.sessionId}.json`);
    const cur = exists(dest) ? Number(readJsonOr<{ lastActivityAt?: number }>(dest, {}).lastActivityAt ?? 0) : -1;
    if (r.lastActivityAt > cur) {
      ensureDir(path.dirname(dest));
      fs.copyFileSync(r.path, dest);
      indexes++;
    }
    const src = transcripts.get(r.cliSessionId.toLowerCase());
    if (src) {
      const tdest = path.join(vaultDir, 'transcripts', `${r.cliSessionId}.jsonl`);
      const s = fs.statSync(src);
      const d = exists(tdest) ? fs.statSync(tdest) : null;
      if (!d || d.size !== s.size || d.mtimeMs < s.mtimeMs) {
        ensureDir(path.dirname(tdest));
        fs.copyFileSync(src, tdest);
        copied++;
      }
    }
  }
  return { indexes, transcripts: copied };
}
