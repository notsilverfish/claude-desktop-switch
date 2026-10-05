# Phase 0 spike

Throwaway experiment that answers, for Claude Desktop on Windows:

1. Which files hold the login (config keys, cookies, browser storage)?
2. Can the app be quit and relaunched reliably from a script?
3. Does swapping those files switch accounts, and what is the smallest set that works?
4. Does `--user-data-dir` give a separate, isolated profile?

Run it from a normal Windows Terminal window, **not** from a terminal inside Claude Desktop:

```
node spike.mjs status     # read-only
node spike.mjs run        # guided experiment, resumable
node spike.mjs udd-test   # optional isolated-profile test
node spike.mjs rescue     # put the original login back
```

Everything (captures, backups, results) is stored in
`%LOCALAPPDATA%\claude-desktop-switch-spike`. Results: `results\summary.md`, `results\log.jsonl`.
Token values are never printed or decrypted; logs contain only file names, hashes and account UUIDs.
