import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '../src/context.js';
import { fakeApp } from '../src/platform/processes.js';
import { out } from '../src/util/output.js';

// A throwaway Claude data folder + tool home, with the app simulated in memory.
export interface Sandbox {
  root: string;
  data: string;
  home: string;
  claudeHome: string;
  ctx: Context;
  signIn(uuid: string, token: string, cookie?: string): void;
  live(): Record<string, unknown>;
  cookie(): string | null;
  cleanup(): void;
}

process.env.CDS_FAKE_PROCESSES = '1';
process.env.CDS_NO_ANIMATION = '1';
process.env.CDS_SETTLE_MS = '0';
process.env.CDS_VERIFY_MS = '0';
process.env.CDS_POLL_MS = '20';
out.quiet = true;
out.yes = true;

export function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdsw-test-'));
  const data = path.join(root, 'data');
  const home = path.join(root, 'home');
  const claudeHome = path.join(root, 'dot-claude');
  fs.mkdirSync(path.join(data, 'Network'), { recursive: true });
  fs.mkdirSync(path.join(data, 'Local Storage', 'leveldb'), { recursive: true });
  fs.mkdirSync(path.join(data, 'claude-code-sessions'), { recursive: true });
  fs.writeFileSync(path.join(data, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'KEY1' } }));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ locale: 'en-US', windowSizeWasSignedIn: true }, null, '\t'));
  process.env.CDS_DATA = data;
  process.env.CDS_HOME = home;
  process.env.CDS_CLAUDE_HOME = claudeHome;
  fakeApp.running = false;
  fakeApp.launches = 0;
  fakeApp.quits = 0;
  fakeApp.onLaunch = undefined;

  const configFile = path.join(data, 'config.json');
  const sb: Sandbox = {
    root,
    data,
    home,
    claudeHome,
    ctx: new Context({ yes: true, quiet: true }),
    signIn(uuid, token, cookie = `cookie-${uuid}`) {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      Object.assign(config, { lastKnownAccountUuid: uuid, 'oauth:tokenCacheV2': token, 'oauth:tokenCache': `${token}-v1` });
      fs.writeFileSync(configFile, JSON.stringify(config, null, '\t'));
      // A local sign-out removes these folders; the app recreates them on sign-in.
      fs.mkdirSync(path.join(data, 'Network'), { recursive: true });
      fs.mkdirSync(path.join(data, 'Local Storage', 'leveldb'), { recursive: true });
      fs.writeFileSync(path.join(data, 'Network', 'Cookies'), cookie);
      fs.writeFileSync(path.join(data, 'Local Storage', 'leveldb', '000003.log'), `ls-${uuid}`);
    },
    live: () => JSON.parse(fs.readFileSync(configFile, 'utf8')),
    cookie: () => (fs.existsSync(path.join(data, 'Network', 'Cookies')) ? fs.readFileSync(path.join(data, 'Network', 'Cookies'), 'utf8') : null),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
  return sb;
}

export const UUID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
export const UUID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
export const UUID_C = 'cccccccc-3333-4333-8333-333333333333';
