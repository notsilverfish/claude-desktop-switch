import { c as pc } from '../util/output.js';
import type { Context } from '../context.js';
import { readLiveAccount } from '../core/auth.js';
import {
  deleteProfile, findByAccount, listProfiles, profileHasLogin, renameProfile, requireProfile, type Profile,
} from '../core/profiles.js';
import { addAccount, saveCurrent, switchTo } from '../core/switcher.js';
import { CdsError } from '../errors.js';
import { choose, confirm, ok, out, printJson, say, table, warn } from '../util/output.js';
import { relativeTime, runOutsideDesktopIfNeeded, shortId } from './common.js';

interface LaunchFlag {
  launch: boolean;
}

function liveUuid(ctx: Context): { uuid: string | null; signedIn: boolean } {
  try {
    const live = readLiveAccount(ctx.dataDir);
    return { uuid: live.uuid, signedIn: live.hasTokens && Boolean(live.uuid) };
  } catch {
    return { uuid: null, signedIn: false };
  }
}

export function listCommand(ctx: Context): void {
  const profiles = listProfiles(ctx.home);
  const live = liveUuid(ctx);
  if (out.json) {
    printJson(profiles.map((p) => ({ ...p, active: live.signedIn && p.accountUuid === live.uuid, hasLogin: profileHasLogin(ctx.home, p) })));
    return;
  }
  if (!profiles.length) {
    say('No saved profiles yet.');
    say(`Save the account that is signed in now:  ${pc.cyan('claude-switch save <name>')}`);
    say(`Or sign in to another account:            ${pc.cyan('claude-switch add <name>')}`);
    return;
  }
  table(
    profiles.map((p) => {
      const active = live.signedIn && p.accountUuid === live.uuid;
      const status = p.status === 'needs-login' ? pc.yellow('needs sign-in')
        : !profileHasLogin(ctx.home, p) ? pc.yellow('no saved login') : pc.green('ok');
      return [active ? pc.green('●') : ' ', active ? pc.bold(p.name) : p.name, shortId(p.accountUuid), relativeTime(p.savedAt), status];
    }),
    [' ', 'PROFILE', 'ACCOUNT', 'SAVED', 'STATUS'],
  );
  if (live.signedIn && !findByAccount(ctx.home, live.uuid)) {
    say();
    warn(`The signed-in account (${shortId(live.uuid)}) is not saved. Save it with: claude-switch save <name>`);
  }
}

export function currentCommand(ctx: Context): void {
  const live = liveUuid(ctx);
  const profile = live.signedIn ? findByAccount(ctx.home, live.uuid) : undefined;
  if (out.json) {
    printJson({ signedIn: live.signedIn, accountUuid: live.uuid, profile: profile?.name ?? null });
    return;
  }
  if (!live.signedIn) say('Claude Desktop is signed out.');
  else if (profile) say(profile.name);
  else say(`Account ${live.uuid} (not saved; save it with: claude-switch save <name>)`);
}

export async function useCommand(ctx: Context, name: string | undefined, opts: LaunchFlag): Promise<void> {
  if (!name) {
    const live = liveUuid(ctx);
    const choices = listProfiles(ctx.home).filter((p) => !(live.signedIn && p.accountUuid === live.uuid));
    if (!choices.length) throw new CdsError('No other saved profiles to switch to.', 'Add one with: claude-switch add <name>');
    if (out.yes) throw new CdsError('Name the profile to switch to.', 'claude-switch use <name>');
    name = (await choose('Switch to', choices, (p) => `${p.name} ${pc.dim(shortId(p.accountUuid))}`)).name;
  }
  requireProfile(ctx.home, name);
  if (await runOutsideDesktopIfNeeded(ctx, 'use')) return;
  const r = await switchTo(ctx, name, opts);
  if (out.json) printJson(r);
}

export async function addCommand(ctx: Context, name: string, opts: LaunchFlag): Promise<void> {
  if (await runOutsideDesktopIfNeeded(ctx, 'add')) return;
  const r = await addAccount(ctx, name, opts);
  if (out.json) printJson(r);
}

export async function saveCommand(ctx: Context, name: string | undefined, opts: LaunchFlag): Promise<void> {
  if (await runOutsideDesktopIfNeeded(ctx, 'save')) return;
  const r = await saveCurrent(ctx, name, opts);
  if (out.json) printJson(r);
}

export function renameCommand(ctx: Context, from: string, to: string): void {
  const profile = requireProfile(ctx.home, from);
  const old = profile.name;
  const r = renameProfile(ctx.home, profile, to);
  ok(`Renamed "${old}" to "${r.name}".`);
  if (out.json) printJson(r);
}

export async function removeCommand(ctx: Context, name: string): Promise<void> {
  const profile: Profile = requireProfile(ctx.home, name);
  const live = liveUuid(ctx);
  const isActive = live.signedIn && profile.accountUuid === live.uuid;
  const note = isActive ? ' Claude Desktop stays signed in to it; only the saved copy is deleted.' : '';
  if (!(await confirm(`Delete the saved login "${profile.name}"?${note}`, false))) {
    throw new CdsError('Cancelled.', undefined, 3);
  }
  deleteProfile(ctx.home, profile);
  ok(`Deleted profile "${profile.name}".`);
  if (out.json) printJson({ removed: profile.name });
}
