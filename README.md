# seafile-mcp (Seafile MCP connector)

MCP connector for a self-hosted [Seafile](https://github.com/haiwen/seafile) server (seahub). It speaks the seahub HTTP API over stdio and over stateless Streamable HTTP on localhost.

Seafile server is GPLv2. This connector is MIT. It only calls the HTTP API on the server you configure. It is not affiliated with Seafile Ltd. Bring your own account token or library API token.

`seafile.routes.json` is a route table derived with `ast` from haiwen/seahub v14.0.9-server (`seahub/urls.py` and `seahub/api2/urls.py`). It is not an official OpenAPI document, and it has no request body schemas. The connector covers all 655 routes in that table (`/api2/*` and `/api/v2.1/*`). Routes are grouped into 24 toolsets. `SEAFILE_TOOLSETS` selects a subset. The default set is small and read-focused. `all` enables every toolset, including admin.

There is no default base URL. `SEAFILE_URL` is required. Hosts on `seafile.com`, including `cloud.seafile.com`, are refused.

## Setup

```bash
npm install
npm run ci
npm start
npm run start:http
```

`npm start` speaks stdio. `npm run start:http` serves Streamable HTTP at `http://127.0.0.1:3000/mcp` and `GET /health`. HTTP mode has no authentication of its own. Keep it on localhost.

Create a token with `POST /api2/auth-token/` on your server, or create a library API token in the Seafile UI. Put it in `SEAFILE_TOKEN`. The connector sends `Authorization: Token` and never prints the token. It does not store a username or password. A library API token cannot delete, move, or copy.

```json
{
  "mcpServers": {
    "seafile": {
      "command": "node",
      "args": ["/workspace/connectors/seafile/dist/index.js"],
      "env": {
        "SEAFILE_URL": "http://127.0.0.1:8000",
        "SEAFILE_TOKEN": "...",
        "SEAFILE_ALLOW_WRITES": "false",
        "SEAFILE_TOOLSETS": "server,libraries,files_and_dirs,search",
        "SEAFILE_CONTACT": "you@example.com"
      }
    }
  }
}
```

If the file server is on another origin than `SEAFILE_URL`, set `SEAFILE_FILE_SERVER_URL` to that origin (often port 8082). `read_text_file` and `write_text_file` fetch only that origin, the `SEAFILE_URL` origin, or a `/seafhttp` path on the same host. They do not follow redirects to any other host.

Docker (HTTP, no authentication, localhost only):

```bash
docker build -t seafile-mcp .
docker run -p 3000:3000 \
  -e SEAFILE_URL=http://host.docker.internal:8000 \
  -e SEAFILE_TOKEN=... \
  seafile-mcp
```

Do not put the token in the image.

Regenerate the operations registry after a route-table bump:

```bash
npm run gen:operations
```

## Config

| Variable                     | Meaning                                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEAFILE_URL`                | Required. Self-hosted seahub origin. No default. `seafile.com` hosts are refused.                                                                                                                  |
| `SEAFILE_TOKEN`              | Account token or library API token. Sent as `Authorization: Token`.                                                                                                                                |
| `SEAFILE_FILE_SERVER_URL`    | Optional file-server origin for upload and download URLs that are not on `SEAFILE_URL`. Hosted Seafile domains are refused.                                                                        |
| `SEAFILE_REVEAL_LINK_TOKENS` | Optional, default off. Set to `true` to show share and upload link tokens and URLs, so a created link can be given out and deleted by token. Account token and passwords stay redacted either way. |
| `SEAFILE_ALLOW_WRITES`       | Must be the literal `true` before a confirmed write is sent.                                                                                                                                       |
| `SEAFILE_TOOLSETS`           | Comma list of toolsets, or `all`. Default `server,libraries,files_and_dirs,search`.                                                                                                                |
| `SEAFILE_PER_MINUTE`         | Local request budget. Default 30.                                                                                                                                                                  |
| `SEAFILE_TIMEOUT_MS`         | Upstream timeout. Default 20000.                                                                                                                                                                   |
| `SEAFILE_CACHE_TTL_SEC`      | GET cache TTL. Default 60. Writes clear the cache.                                                                                                                                                 |
| `SEAFILE_CONTACT`            | Contact token in the User-Agent.                                                                                                                                                                   |
| `MCP_TRANSPORT`              | `stdio` or `http`. `--http` overrides.                                                                                                                                                             |
| `PORT`                       | HTTP port. Default 3000.                                                                                                                                                                           |

## Safety

Every non-GET route is a write. So is any GET that mints a download URL, upload URL, update URL, auth token, WebDAV secret, SSO link, or similar credential. A write needs `confirm` set to the boolean `true` and `SEAFILE_ALLOW_WRITES=true`. Otherwise the tool returns a dry-run preview of the method, path, query, and redacted body, and it sends nothing. The string `"true"` and the boolean `false` are rejected.

Delete, purge, expire, revert, trash clean, move, copy, and overwrite previews name the library id and the path. The same warning is in the tool description for destructive and credential actions.

`read_text_file` and `write_text_file` are extra actions on `seafile_files_and_dirs`. Both are gated. They stay inside one library path (absolute, no `..`). Text only. 256 KiB cap. `write_text_file` `replace` defaults to false. `replace: true` adds an overwrite warning and names the target.

Responses are parsed as JSON objects, arrays (`items`), or strings (`value`). `stack` and traceback fields are dropped. Error text drops server stack traces and filesystem paths. Field names for tokens, passwords, `pwd_hash`, `magic`, and `random_key` are redacted. Share-link and file-server tokens in URLs are redacted. `repo_id` is kept.

HTTP 401 is unauthorized. HTTP 403 is forbidden. HTTP 404 is not found. HTTP 400 and 422 are invalid. HTTP 429 is rate limited and includes Retry-After. HTTP 5xx is a server error. Connection failures are network errors. Timeouts are timeouts.

`/api2/` bodies are sent as form fields. `/api/v2.1/` bodies are sent as JSON. Query object and body object are free-form because the route table has no schemas.

## Tools

Default `SEAFILE_TOOLSETS` publishes 4 tools. `SEAFILE_TOOLSETS=all` publishes 24 tools (655 route operations, plus `read_text_file` and `write_text_file` on the files tool). Each tool takes `action` plus `params`, `query`, `body`, and `confirm` when the tool can write.

| Toolset         | Tool                      | Operations | Default |
| --------------- | ------------------------- | ---------- | ------- |
| server          | `seafile_server`          | 46         | yes     |
| libraries       | `seafile_libraries`       | 39         | yes     |
| files_and_dirs  | `seafile_files_and_dirs`  | 74         | yes     |
| search          | `seafile_search`          | 6          | yes     |
| history_trash   | `seafile_history_trash`   | 24         | no      |
| share_links     | `seafile_share_links`     | 35         | no      |
| upload_links    | `seafile_upload_links`    | 12         | no      |
| library_sharing | `seafile_library_sharing` | 41         | no      |
| groups          | `seafile_groups`          | 54         | no      |
| tags            | `seafile_tags`            | 17         | no      |
| starred         | `seafile_starred`         | 6          | no      |
| notifications   | `seafile_notifications`   | 14         | no      |
| activities      | `seafile_activities`      | 1          | no      |
| invitations     | `seafile_invitations`     | 6          | no      |
| address_book    | `seafile_address_book`    | 5          | no      |
| wikis           | `seafile_wikis`           | 47         | no      |
| via_repo_token  | `seafile_via_repo_token`  | 40         | no      |
| ocm             | `seafile_ocm`             | 8          | no      |
| admin_users     | `seafile_admin_users`     | 20         | no      |
| admin_libraries | `seafile_admin_libraries` | 23         | no      |
| admin_groups    | `seafile_admin_groups`    | 14         | no      |
| admin_logs      | `seafile_admin_logs`      | 29         | no      |
| admin_shares    | `seafile_admin_shares`    | 15         | no      |
| admin_system    | `seafile_admin_system`    | 79         | no      |

Example. List libraries, preview a create, then confirm it.

```json
{ "action": "list_repos" }
```

```json
{ "action": "create_repo", "body": { "name": "Lab" } }
```

```json
{ "action": "create_repo", "body": { "name": "Lab" }, "confirm": true }
```

Read a text file after you set `SEAFILE_ALLOW_WRITES=true`.

```json
{
  "action": "read_text_file",
  "params": { "repo_id": "REPO" },
  "query": { "p": "/notes/a.txt" },
  "confirm": true
}
```

## Live check

`npm run live-check` and `npm run live-check:extra` talk to a real Seafile server when `SEAFILE_URL` and `SEAFILE_TOKEN` are set (`SEAFILE_FILE_SERVER_URL` too, if the fileserver is on another origin). They were run against a real local Seafile 9.0.10 server: failed=0, 59 checks. See [LIVE-CHECK.md](LIVE-CHECK.md) for exactly what was and was not exercised. They print pass and fail lines only and never the token.

This session did not run the live check. The parent runs it against a local server.

## What this is not

This is not a Seafile desktop sync client. It does not watch folders or speak the sync protocol.

This is not a client for Seafile Cloud or any `seafile.com` host.

This is not an official OpenAPI SDK. Body fields come from seahub view code for the common routes and are free-form everywhere else.

This connector does not keep your password, and it does not turn a library API token into an account token. `POST /api2/auth-token/` is a gated credential write. Its token is redacted in the result.

Admin toolsets are off unless you set `SEAFILE_TOOLSETS`.

## Attribution

Seafile server is GPLv2. This connector is MIT and is not a derivative of the Seafile server. It is an independent HTTP client of the seahub API.

## License

MIT, see [LICENSE](LICENSE). This is an independent, unofficial connector and is not endorsed by the Seafile project or its owners.

seafile.routes.json is a route table derived from haiwen/seahub (Apache-2.0).
