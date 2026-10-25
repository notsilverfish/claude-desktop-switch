# Changelog

## 0.1.1

- Works with Claude Desktop 3.x, which moved its data to `%LOCALAPPDATA%\Claude-Data`. 0.1.0 could not find it and stopped with "data folder not found". Saved profiles keep working; nothing needs to be re-saved.
- When an update leaves an old data folder behind, the one Claude wrote to most recently is used.
- Claude Code sessions running in Claude Desktop 3.x are recognised again, so you are warned before a switch stops them.

## 0.1.0

First release. Windows, Claude Desktop (Microsoft Store and classic installer).

- `claude-switch save / add / use / list / current / rename / remove`: save Claude Desktop logins as profiles and switch between them without signing in again. The account that is signed in is saved before every switch, so refreshed tokens are never lost.
- Every change is backed up and journaled; `claude-switch repair` finishes or undoes an interrupted switch, and `claude-switch backups` lists the automatic backups.
- After a switch, Claude is started and the login is checked; a rejected login marks the profile "needs sign-in".
- Run from Claude Desktop's own terminal, the switch continues in a background process so it is not killed when Claude closes.
- `claude-switch sessions` / `sessions merge`: Code-tab chats per account; copying chats between sidebars only when asked. Chats you deleted are never brought back, archived ones stay archived.
- `claude-switch export`: a redacted copy of your Claude configuration, never including logins.
- `claude-switch usage`: what local Claude Code usage would cost at API prices, priced for every current model.
- `claude-switch doctor`: checks the install, data folder, saved profiles and leftovers from interrupted operations.
- One-file bundle with no runtime dependencies.
