# claude-switch

Use more than one Claude account in the Claude desktop app, and switch between them with one command. No more signing out and back in.

Works on Windows.

## Install

You need [Node.js](https://nodejs.org) (version 20 or newer). Then open a terminal and run:

```
npm install -g claude-desktop-switch
```

That gives you the `claude-switch` command.

> **PowerShell says "running scripts is disabled"?** Type `claude-switch.cmd` instead of `claude-switch`. It works the same. Or fix it once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## First time: save your accounts

Open the Claude app and sign in like you normally do. Then:

**1. Save the account you're signed in to.** Give it any name you like:

```
claude-switch save work
```

**2. Add your other account:**

```
claude-switch add personal
```

The Claude app closes and opens again at the sign-in screen. Sign in to your other account there. The tool notices, saves it, and tells you when it's done.

Do this for each account you have. You only ever sign in once per account.

## Every day: switch accounts

```
claude-switch use personal
```

The Claude app closes, switches, and opens again signed in to `personal`. That's it.

Not sure what you called them? Just run:

```
claude-switch
```

It shows all your saved accounts. The one with a green dot (●) is the one you're using now.

Or run `claude-switch use` with no name and pick from a list.

## All the commands

| Type this | What happens |
|---|---|
| `claude-switch` | Shows your saved accounts |
| `claude-switch save <name>` | Saves the account you're signed in to now |
| `claude-switch add <name>` | Signs in to another account and saves it |
| `claude-switch use <name>` | Switches to that account |
| `claude-switch current` | Shows which account you're using |
| `claude-switch rename <name> <new name>` | Renames a saved account |
| `claude-switch remove <name>` | Forgets a saved account (doesn't sign you out) |
| `claude-switch doctor` | Checks that everything is OK |
| `claude-switch --help` | Shows all commands |

`csw` is a short name for `claude-switch`. For example, `csw use work`.

## Good to know

**Will I lose my chats or settings?** No. Only the login changes. Your settings, connectors and chats stay put.

**Why does the Claude app close?** It has to be closed while the login is swapped. It opens again by itself. Any Claude Code task running in the app stops, so finish it first.

**Each account has its own Code chats.** In the Code tab, every account sees its own list of chats. If you want chats from your other accounts in this one too, run `claude-switch sessions merge`. It shows what it will copy and asks first. Chats you deleted stay deleted.

**A login stopped working.** Logins can expire, for example if you signed out of that account somewhere else. Run `claude-switch add <name>` with the same name and sign in again. It updates the saved login.

**Something went wrong in the middle of a switch.** Run `claude-switch repair`. A backup is made before every switch, so it can put things back.

**Is it safe?** Your saved logins stay on your computer, in a folder only your Windows user can open. Nothing is sent anywhere. Saved logins only work on this PC, for your Windows user. Only use it for accounts that are yours (or that you're allowed to use), like a personal and a work account.

**Claude updated and now something's off?** Run `claude-switch doctor`. It tells you what's wrong and what to do.

## Extra tools

| Type this | What happens |
|---|---|
| `claude-switch sessions` | Shows how many Code chats each account has |
| `claude-switch sessions merge` | Copies Code chats from your other accounts into this one (add `--dry-run` to just preview) |
| `claude-switch export` | Saves a copy of your Claude settings, memory and skills to a folder. Passwords and keys in it are blanked out, and logins are never included |
| `claude-switch usage` | Shows roughly what your Claude Code use would cost if you paid API prices (add `--since 7d` for the last week) |
| `claude-switch backups` | Lists the automatic backups made before each switch |

---

## For the curious: how it works

Claude Desktop keeps its login in its data folder: two encrypted token entries and the active account id in `config.json`, plus the claude.ai cookies and browser storage. A switch:

1. Closes Claude Desktop. It ignores a normal close request and keeps running in the tray, so after a few seconds the tool ends its processes.
2. Saves the account that is signed in now, so tokens refreshed since the last save are kept.
3. Backs up the live login, then swaps in the target profile's files. A journal entry is written first, so `claude-switch repair` can undo an interrupted switch.
4. Starts Claude Desktop and checks that it accepted the login. If it didn't (expired, or signed out elsewhere), the profile is marked "needs sign-in".

Token values are never decrypted, printed or sent anywhere, and the tool makes no network requests. Saved logins live in `%LOCALAPPDATA%\claude-desktop-switch`, which is locked to your Windows user; Windows encrypts the tokens for your user on this PC. If Claude Desktop is reinstalled, its encryption key changes and saved logins stop working; the tool detects this and asks you to sign in again rather than breaking the app.

Microsoft Store installs keep their data in `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude`. `%APPDATA%\Claude` only mirrors that folder while the app runs, so the tool always uses the package folder.

Run from a terminal inside Claude Desktop, a switch would kill its own terminal. The tool detects that, asks, and continues in a background process outside Desktop; the log goes to `%LOCALAPPDATA%\claude-desktop-switch\logs`.

Options for scripts: `--json` for machine-readable output, `-y` to skip questions, `-q` for quiet, `--no-launch` to leave Claude closed, `--data-dir` for a non-standard data folder.

Claude Desktop's file layout is not a public interface and can change with any update.

## Development

```
npm install
npm test          # runs against a simulated Claude Desktop; never touches the real app
npm run build     # bundles everything into dist/claude-switch.mjs (no runtime dependencies)
npm link          # puts claude-switch and csw on your PATH, pointing at this folder
```

After `npm link`, every `npm run build` takes effect immediately. Run it from your own terminal: an install made from a terminal inside the Claude desktop app lands in the app's private sandbox. `npm unlink -g claude-desktop-switch` removes it.

`CDS_FAKE_PROCESSES=1` with `CDS_DATA` and `CDS_HOME` pointing at temporary folders runs the CLI against a fake install. Under a test runner, real process control is refused outright.

Releases: bump the version in `package.json`, then push a matching tag (`v0.1.1`). GitHub Actions tests and publishes it to npm with provenance.

`spike/` holds the Phase 0 experiment that confirmed which files make up a login.

If you also have the unrelated `claude-switch` npm package installed, uninstall it first: both install a `claude-switch` command.
