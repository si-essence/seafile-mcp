# Live check against a real Seafile server

Run on 27 Oct 2026 (Africa/Accra) on the box, with no sign-up, no Docker and `DATABASE_URL` unset.

## What the server was (read this first)

- **Seafile server 9.0.10**, the last prebuilt generic tarball (`seafile-server_9.0.10_x86-64.tar.gz` from download.seadrive.org). Newer releases ship as Docker images only, and there is no Docker here.
- The route table the connector is generated from is **seahub v14.0.9-server**. So this check proves the connector against the routes that 9.0.10 also has. Routes that exist only in 10.x to 14.x (parts of wikis, SDoc, OCM, some admin and tag routes) were **not** exercised live.
- Setup: the tarball's own `setup-seafile.sh` (SQLite, no MariaDB), seahub on `127.0.0.1:8000`, fileserver on `127.0.0.1:8082`. Seahub's Python deps were installed into a Python 3.8 venv (via `uv`), because the bundled thirdparty `.so` files are built for Python 3.6; a few bundled packages (`cffi`, `cryptography`, `yaml`, `OpenSSL`, `PIL`) were moved aside so the venv's builds load. A tiny `sqlite3` CLI shim (Python) stood in for the missing `sqlite3` binary. This is instance setup, not a connector change.
- An admin user was created by the tarball's own admin prompt (local only, password in a 600 file, never printed). An account token came from `POST /api2/auth-token/` and is in a 600 `live.env`.
- `SEAFILE_FILE_SERVER_URL=http://127.0.0.1:8082` was set, because the fileserver is on a different origin than seahub on this layout.

## Commands

```
SEAFILE_URL=http://127.0.0.1:8000 SEAFILE_TOKEN=... SEAFILE_FILE_SERVER_URL=http://127.0.0.1:8082 npm run live-check
... npm run live-check:extra
```

Both spawn `dist/index.js` over stdio with `SEAFILE_TOOLSETS=all`. The first run uses `SEAFILE_ALLOW_WRITES=true`. The extra run also uses `SEAFILE_REVEAL_LINK_TOKENS=true` and a second client with writes off.

## Result: failed=0 on both (25 + 34 checks)

Exercised for real (preview first for each write, then confirmed):

- list tools (24), ping, server info, account info
- libraries: list, create, get, delete (a library is created and deleted in each run)
- directories: create, list, get
- files: write text file, read text file, file detail, copy, rename, move, delete (to trash), file history, trash listing shows the deleted file
- text helpers go through the real fileserver upload and download links, on the allowed origin only
- starred items: create, list, delete
- upload links: create (token shown with the opt-in), list per library, delete by token
- share links: create (token shown with the opt-in), get by token, delete by token. With the opt-in off the token is `[redacted]` (unit-tested; the live run confirms the writes-off client sends nothing)
- groups: create, list, delete
- admin toolset: list users, list libraries
- search route returns a clean `invalid` error for a missing `repo_id` (not a crash)
- unknown library id returns a clean `not-found` with no stack or filesystem path
- `confirm: true` with `SEAFILE_ALLOW_WRITES` unset sends nothing (blocked preview); `confirm: "true"` is rejected at input validation
- the account token never appeared in any output (checked on every call)

## Not exercised live

- every other route in the 655-route table (about 600): wikis, OCM, via-repo-token, tags, invitations, notifications, address book, most admin routes, library sharing to users and groups, trash restore and clean, history revert, encrypted libraries, and anything new after 9.0.10
- those are covered by the mock HTTP tests (every tool, preview and confirmed, plus 401/403/404/422/400/429) and by the route-table coverage test only
- a real MariaDB-backed install, SSO or two-factor accounts, and Seafile Pro features
