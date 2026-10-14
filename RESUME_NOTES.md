# Handoff for router-dependent Claude session

## User goal and flow
Multiple Codex OAuth accounts in 9router -> 9router endpoint and API key exported in ~/.zshrc -> Claude Code. Initial symptom: waiting/check network, then empty/malformed HTTP200; long report/subagent streams affected.

## Checkout and patch
- /Users/minhphuongeec/9router, branch fix/claude-stream-reliability.
- Based on cmduc008/9router master ce4460ef79382bfddb4aa5fc0ff9f3cb0d5f95a8, version0.5.99.
- No commits or push.
- Patched Claude downstream keepalive, raw watchdog/cancellation, Responses→Claude EOF/error semantics, terminal-only text/tool snapshot preservation/dedup.
- Important reproduced bug: forced Codex SSE→JSON returned OpenAI chat.completion for Claude. Now reuses Claude Message conversion through shared utility.
- Reviewed snapshot correlator defects fixed with additional tests.
- Final focused run: 85 tests passed across10 files. Additional missing-production-DB launcher guard tested4/4; latest handoff subset23/23. Production build passed. Full suite has preexisting failures; original fork comparison detected no new assertion failures after checking flaky MiniMax snapshots.

## Critical safety instruction from user
This session uses the package router on20128. Do not start a replacement there, stop package service, change shell/API key, or run two copies of the same OAuth grants. An earlier launcher test wrongly started isolated data on20128; acknowledged mistake, stopped test, package was verified restored. User explicitly corrected this. Subsequent testing offline mocks only.

## Account readiness
- USER UPDATED REQUEST: put data in local repo folder. Created PRIVATE IGNORED snapshot /Users/minhphuongeec/9router/data/production (7accounts/2keys integrityok). Never commit/push. This supersedes old same-DATA_DIR instructions. Package original remains ~/.9router. Snapshot marker blocks local startup until user stops package and runs python3 -I scripts/sync-local-data.py to refresh latest tokens once. Script guards open DB/listener, gitignore and one-time import. Local command DATA_DIR=$HOME/9router/data/production npm run start:local -- --production. Never run both copies; package old database becomes stale after local rotation. Rollback needs newest credentials, not old default package DB.
- Private online SQLite backup /Users/minhphuongeec/.9router-local-backups/20261012-110033/data.sqlite (WAL-aware SQLite backup API; integrity_check=ok), jwt-secret copied privately.
- Snapshot7 Codex accounts5active,2APIkeys,1settings row; metadata schemaVersion1/appVersion0.5.99.
- Package remains installed and active; last verified PID57977 cport20128, reads ~/.9router database. Never assume PID unchanged on resume.
- Local accounts have not been opened by a live local service. Real-provider testing and user cutover pending.
- start-local.mjs uses production mode explicit --production; refuses occupied port or already-open production database; staging defaults20127+explicit isolated DATA_DIR, rejects production path/port.
- Backup is point-in-time; OAuth refresh may rotate tokens later. Rollback should keep newest compatible data, not blindly restore backup.

## Resume
Session ID bd98dc10-42b3-44a3-af61-01bddfcf6254; local transcript verified under ~/.claude/projects/-Users-minhphuongeec/. User intends to close session, manually stop package, start local, generate/use API key and update zshrc, then resume.
On resume verify current listener/cwd/data source and do not ask for tokens. Test short text then tool-use and long report sequentially. Confirm cx/gpt-6.1-sol resolves; stale wrapper claude-9router forced cc-free and different subagent model. Read LOCAL_RUN.md for user procedure. Do not declare all upstream failures solved before real tests.
