# claude-desktop-switch

Save Claude Desktop logins as profiles and switch accounts from the command line, without signing in again. Windows only for now.

```
npm install -g claude-desktop-switch
```

The package is `claude-desktop-switch`; the command is `claude-switch` (short alias `csw`). If you also have the unrelated `claude-switch` npm package installed, uninstall it first: both install a `claude-switch` command.

## Quick start

```
claude-switch save work        # save the account that is signed in now as "work"
claude-switch add personal     # sign in to another account and save it as "personal"
claude-switch use work         # switch back (Claude Desktop closes and reopens)
claude-switch                  # list profiles; ● marks the one signed in now
```

## Commands

| Command | What it does |
|---|---|
| `claude-switch list` | Saved profiles, their accounts, when they were saved, and their status |
| `claude-switch current` | The profile that is signed in now |
| `claude-switch use [profile]` | Switch to a profile (asks which one if you leave it out) |
| `claude-switch add <name>` | Sign in to another account and save it. Re-run with an existing name to refresh an expired login |
| `claude-switch save [name]` | Save the signed-in account |
| `claude-switch rename <profile> <new-name>` | Rename a profile |
| `claude-switch remove <profile>` | Delete a saved profile (Claude stays signed in) |
| `claude-switch sessions list [profile]` | Code-tab chats per account |
| `claude-switch sessions merge` | Copy chats from other accounts into the signed-in account's sidebar (`--dry-run` to preview, `--from` to pick accounts, `--vault` to recover from an old vault folder) |
| `claude-switch export` | A redacted copy of your Claude configuration: settings, memory, skills, MCP config, sidebar records. Never includes logins |
| `claude-switch usage` | What your local Claude Code usage would cost at API prices (`--since 7d`, `--out <dir>` for Markdown/CSV) |
| `claude-switch doctor` | Check the installation and look for problems |
| `claude-switch backups` / `claude-switch repair` | List automatic login backups / recover from an interrupted switch or restore a backup |

Global options: `--json` for machine-readable output, `-y` to skip confirmations, `-q` for quiet, `--data-dir` to point at a non-standard data folder.

## How it works

Claude Desktop keeps its login in its data folder: two encrypted token entries and the active account id in `config.json`, plus the claude.ai cookies and browser storage. A switch:

1. Closes Claude Desktop. It ignores a normal close request and keeps running in the tray, so after a few seconds the tool ends its processes.
2. Saves the account that is signed in now, so tokens refreshed since the last save are kept.
3. Backs up the live login, then swaps in the target profile's files. A journal entry is written first, so `claude-switch repair` can undo an interrupted switch.
4. Starts Claude Desktop and checks that it accepted the login. If it didn't (expired, or signed out elsewhere), the profile is marked "needs sign-in".

Only the login changes. Settings, MCP servers, extensions and chats stay as they are. Each account keeps its own Code-tab sidebar; `claude-switch sessions merge` copies chats across only when you ask. Chats you deleted are never brought back.

Microsoft Store installs keep their data in `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude`. `%APPDATA%\Claude` only mirrors that folder while the app runs, so the tool always uses the package folder.

### Running from Claude Desktop's own terminal

Closing Claude Desktop would also kill a terminal running inside it. When the tool detects that, it asks, then continues in a background process outside Desktop and reopens Claude when done. The log goes to `%LOCALAPPDATA%\claude-desktop-switch\logs`.

## Security

- Token values are never decrypted, printed or sent anywhere. The tool makes no network requests.
- Saved logins live in `%LOCALAPPDATA%\claude-desktop-switch`, which is locked to your Windows user. Windows encrypts the tokens for your user on this PC, so profiles cannot be moved to another machine.
- If Claude Desktop is reinstalled, its encryption key changes and saved logins stop working. The tool detects this and asks you to sign in again rather than breaking the app.
- `claude-switch export` redacts API keys, tokens, passwords and connection strings in every text file it copies, and skips logins entirely.

Use this for accounts you own or are allowed to use, such as a personal and a work account. Claude Desktop's file layout is not a public interface and can change with any update; run `claude-switch doctor` after updating Claude.

## Development

```
npm install
npm test          # runs against a simulated Claude Desktop; never touches the real app
npm run build     # bundles everything into dist/claude-switch.mjs (no runtime dependencies)
npm link          # puts claude-switch and csw on your PATH, pointing at this folder
```

After `npm link`, every `npm run build` takes effect immediately; nothing needs publishing. Run it from your own terminal: an install made from a terminal inside the Claude desktop app lands in the app's private sandbox. In PowerShell, type `claude-switch.cmd` (or allow local scripts once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`), because PowerShell blocks npm's `.ps1` shims by default. `npm unlink -g claude-desktop-switch` removes it.

`CDS_FAKE_PROCESSES=1` with `CDS_DATA` and `CDS_HOME` pointing at temporary folders runs the CLI against a fake install. Under a test runner, real process control is refused outright.

`spike/` holds the Phase 0 experiment that confirmed which files make up a login.
