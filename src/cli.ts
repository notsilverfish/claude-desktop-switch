// claude-switch CLI entry point.
//
//   claude-switch add / save / use / list     the everyday commands
//   claude-switch sessions / export / usage   chats, config backup, cost estimate
//   claude-switch doctor / backups / repair   when something looks wrong

import fs from 'node:fs';
import { Command, Option } from 'commander';
import { backupCommand, restoreCommand, setupCommand, type BackupFlags, type RestoreFlags } from './commands/backup.js';
import { doctorCommand } from './commands/doctor.js';
import {
  addCommand, currentCommand, listCommand, removeCommand, renameCommand, saveCommand, useCommand,
} from './commands/profiles.js';
import { backupsCommand, repairCommand } from './commands/repair.js';
import { sessionsListCommand, sessionsMergeCommand, type MergeFlags } from './commands/sessions.js';
import { exportCommand, usageCommand } from './commands/tools.js';
import { Context, type GlobalOptions } from './context.js';
import { CdsError } from './errors.js';
import { c, closeInput, out } from './util/output.js';

// The bundle has the version baked in (build.mjs); from source, read package.json.
const VERSION = process.env.CDS_VERSION
  ?? (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const HELP = `claude-switch ${VERSION}: switch Claude Desktop between accounts without signing in again.

Profiles
  claude-switch                         saved profiles; ${c.green('●')} marks the one signed in now
  claude-switch save <name>             save the account that is signed in now
  claude-switch add <name>              sign in to another account and save it (again to refresh it)
  claude-switch use [name]              switch to a profile (asks which one if you leave it out)
  claude-switch current                 the profile that is signed in now
  claude-switch rename <name> <new>     rename a profile
  claude-switch remove <name>           delete a saved profile (Claude stays signed in)

Code-tab chats
  claude-switch sessions [name]         chats per account (each account has its own sidebar)
  claude-switch sessions merge          copy other accounts' chats into this sidebar (--dry-run first)

Moving to another PC (uses amber: npm install -g amber-backup)
  claude-switch backup                  back up your accounts list, chats and config to amber
  claude-switch backup --pick           choose which accounts, folders and chats to include
  claude-switch restore                 on the new PC: bring it all back (after amber login)
  claude-switch setup                   then sign in to each account, once

Tools
  claude-switch export                  a redacted copy of your Claude config (never logins)
  claude-switch usage [--since 7d]      what your Claude Code usage would cost at API prices

When something looks wrong
  claude-switch doctor                  check the installation
  claude-switch backups                 automatic login backups, newest first
  claude-switch repair [--from <when>]  finish or undo an interrupted switch, or restore a backup

Options
  -y, --yes                  don't ask; Claude Desktop is closed when needed
  --no-launch                don't start Claude Desktop afterwards
  --json                     machine-readable output
  -q, --quiet                only errors
  --data-dir <dir>           Claude Desktop's data folder (found automatically)

Short alias: csw. Details for one command: claude-switch <command> --help`;

const program = new Command()
  .name('claude-switch')
  .version(VERSION, '-v, --version')
  .option('--json', 'machine-readable output on stdout')
  .option('-y, --yes', 'do not ask for confirmation (Claude Desktop will be closed when needed)')
  .option('-q, --quiet', 'only print errors')
  .option('--data-dir <dir>', 'Claude Desktop data folder (auto-detected by default)')
  .addOption(new Option('--home <dir>', 'folder for saved profiles').hideHelp())
  .addOption(new Option('--background', 'internal: running outside Claude Desktop').hideHelp())
  .configureOutput({ outputError: (str, write) => write(`  ${c.red('✗')} ${str.replace(/^error: /, '')}`) })
  .showHelpAfterError('  (claude-switch --help lists every command)')
  .argument('[command]')
  .action((cmd: string | undefined) => {
    if (cmd) throw new CdsError(`Unknown command: ${cmd}`, 'claude-switch --help lists every command.');
    return listCommand(ctx());
  });
program.helpInformation = () => HELP + '\n';

function ctx(): Context {
  const opts = program.opts<GlobalOptions>();
  out.json = Boolean(opts.json);
  out.yes = Boolean(opts.yes);
  out.quiet = Boolean(opts.quiet);
  return new Context(opts);
}

const noLaunch = () => new Option('--no-launch', 'do not start Claude Desktop afterwards');

program.command('list').alias('ls').description('show saved profiles (● = signed in now)')
  .action(() => listCommand(ctx()));

program.command('current').description('print the profile that is signed in now')
  .action(() => currentCommand(ctx()));

program.command('use').alias('switch').argument('[profile]', 'profile name (asks if omitted)')
  .description('switch Claude Desktop to a saved profile')
  .addOption(noLaunch())
  .action((name: string | undefined, o: { launch: boolean }) => useCommand(ctx(), name, o));

program.command('add').argument('<name>', 'name for the new profile')
  .description('sign in to another account and save it (re-run with an existing name to refresh it)')
  .addOption(noLaunch())
  .action((name: string, o: { launch: boolean }) => addCommand(ctx(), name, o));

program.command('save').argument('[name]', 'profile name (required the first time)')
  .description('save the account that is signed in now')
  .addOption(noLaunch())
  .action((name: string | undefined, o: { launch: boolean }) => saveCommand(ctx(), name, o));

program.command('rename').argument('<profile>').argument('<new-name>')
  .description('rename a profile')
  .action((from: string, to: string) => renameCommand(ctx(), from, to));

program.command('remove').alias('rm').argument('<profile>')
  .description('delete a saved profile (does not sign Claude out)')
  .action((name: string) => removeCommand(ctx(), name));

program.command('doctor').description('check the installation and look for problems')
  .action(async () => {
    process.exitCode = await doctorCommand(ctx());
  });

program.command('backups').description('list automatic login backups')
  .action(() => backupsCommand(ctx()));

program.command('repair').description('recover from an interrupted switch, or restore a login backup')
  .option('--from <backup>', 'restore this backup (see "claude-switch backups"), or "latest"')
  .addOption(noLaunch())
  .action((o: { from?: string; launch: boolean }) => repairCommand(ctx(), o));

const sessions = program.command('sessions').description('Code-tab chats per account (sidebars stay separate unless you merge)')
  .argument('[profile]', 'show the chats of one account')
  .action((query: string | undefined) => sessionsListCommand(ctx(), query));

sessions.command('list').alias('ls').argument('[profile]', 'show the chats of one account')
  .description("show each account's Code-tab chats")
  .action((query: string | undefined) => sessionsListCommand(ctx(), query));

sessions.command('merge')
  .description("copy chats from other accounts into the signed-in account's sidebar")
  .option('--from <profiles...>', 'only these accounts (profile names or account ids)')
  .option('--vault <dirs...>', "also recover chats from an old vault folder (e.g. the old merger's Vault)")
  .option('--dry-run', 'show what would be copied, change nothing')
  .addOption(noLaunch())
  .action((o: MergeFlags) => sessionsMergeCommand(ctx(), o));

program.command('backup').description('back up accounts, chats and config to amber (never logins)')
  .option('--pick', 'choose accounts, folders and chats (and optionally remember the choice)')
  .option('--all', 'back up every chat (and forget a saved choice)')
  .option('--accounts <profiles...>', 'only these accounts, this time')
  .option('--folders <folders...>', 'only chats from these folders, this time')
  .option('--since <when>', 'only chats active recently, e.g. 30d')
  .option('--name <project>', 'the amber project to back up to (remembered)')
  .option('--no-config', 'leave out the Claude config (settings, memory, skills)')
  .option('--dry-run', 'show what would be backed up, upload nothing')
  .option('--list', 'list the backups stored in amber')
  .action((o: BackupFlags) => backupCommand(ctx(), o));

program.command('restore').description('restore a claude-switch backup from amber (on a new PC)')
  .option('--name <project>', 'the amber project to restore (asks if there are several)')
  .option('--snapshot <id>', 'a specific snapshot instead of the latest')
  .option('--map <OLD=NEW...>', 'move chats to another folder, e.g. C:\\Users\\old=C:\\Users\\new')
  .option('--no-chats', 'only restore the accounts list and config')
  .addOption(noLaunch())
  .action((o: RestoreFlags) => restoreCommand(ctx(), o));

program.command('setup').description('sign in to each account that has no login on this PC yet')
  .action(() => setupCommand(ctx()));

program.command('export').description('save a redacted copy of your Claude configuration (never includes logins)')
  .option('-o, --out <dir>', 'output folder (default: a new folder in the tool folder)')
  .option('--include-transcripts', 'also copy chat transcripts (redacted)')
  .action((o: { out?: string; includeTranscripts?: boolean }) => exportCommand(ctx(), o));

program.command('usage').description('estimate what your local Claude Code usage would cost at API prices')
  .option('--since <when>', 'only count recent usage, e.g. 7d, 24h, 2w or 2026-09-01')
  .option('-o, --out <dir>', 'also write Markdown and CSV reports to this folder')
  .option('--top <n>', 'how many of the most expensive sessions to list', '5')
  .action((o: { since?: string; out?: string; top?: string }) => usageCommand(ctx(), o));

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    if (e instanceof CdsError) {
      process.stderr.write(`  ${c.red('✗')} ${e.message}\n`);
      if (e.hint) process.stderr.write(`    ${c.dim(e.hint)}\n`);
      process.exitCode = e.exitCode;
    } else {
      process.stderr.write(`  ${c.red('✗')} Unexpected error: ${(e as Error).stack ?? e}\n`);
      process.stderr.write(`    ${c.dim('If a switch was in progress, run: claude-switch repair')}\n`);
      process.exitCode = 1;
    }
  } finally {
    closeInput();
  }
}

await main();
