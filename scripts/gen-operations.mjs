#!/usr/bin/env node
/**
 * Generate src/operations.ts from seafile.routes.json.
 * Run: node scripts/gen-operations.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(root, "seafile.routes.json"), "utf8"));
const routes = spec.operations;
if (!Array.isArray(routes)) {
  throw new Error("seafile.routes.json has no operations array");
}

const DEFAULT_TOOLSETS = ["server", "libraries", "files_and_dirs", "search"];

const DESTRUCTIVE_WARNING =
  "This deletes, purges, expires, reverts, or cleans trash. It may be irreversible. The preview names the library id and path.";
const CREDENTIAL_WARNING =
  "This mints or changes a token, key, share link, upload link, or permission. Secrets are redacted in the result.";
const MOVE_WARNING = "This moves or copies items. The preview names the library id and path.";
const EXPOSURE_WARNING = "This changes sharing, permissions, or who can reach the library.";

/** @type {Record<string, string>} */
const ACTION_OVERRIDES = {
  "GET /api2/ping/": "ping",
  "GET /api2/auth/ping/": "auth_ping",
  "GET /api2/server-info/": "server_info",
  "GET /api2/account/info/": "account_info",
  "POST /api2/auth-token/": "create_auth_token",
  "GET /api2/repos/": "list_repos",
  "POST /api2/repos/": "create_repo",
  "GET /api2/repos/{repo_id}/": "get_repo",
  "DELETE /api2/repos/{repo_id}/": "delete_repo",
  "POST /api2/repos/{repo_id}/": "post_repo",
  "GET /api2/repos/{repo_id}/dir/": "list_dir",
  "POST /api2/repos/{repo_id}/dir/": "post_dir",
  "DELETE /api2/repos/{repo_id}/dir/": "delete_dir",
  "GET /api2/repos/{repo_id}/file/": "get_file_download_link",
  "POST /api2/repos/{repo_id}/file/": "post_file",
  "DELETE /api2/repos/{repo_id}/file/": "delete_file",
  "PUT /api2/repos/{repo_id}/file/": "put_file",
  "GET /api2/repos/{repo_id}/upload-link/": "get_upload_link",
  "GET /api2/repos/{repo_id}/update-link/": "get_update_link",
  "GET /api2/repos/{repo_id}/file/detail/": "get_file_detail",
  "GET /api2/search/": "search",
  "GET /api/v2.1/search-file/": "search_file",
  "GET /api/v2.1/repos/{repo_id}/trash/": "list_trash",
  "DELETE /api/v2.1/repos/{repo_id}/trash/": "clean_trash",
  "POST /api/v2.1/repos/{repo_id}/trash/": "post_trash",
  "PUT /api2/repos/{repo_id}/file/revert/": "revert_file",
  "PUT /api2/repos/{repo_id}/dir/revert/": "revert_dir",
  "GET /api/v2.1/share-links/": "list_share_links",
  "POST /api/v2.1/share-links/": "create_share_link",
  "DELETE /api/v2.1/share-links/{token}/": "delete_share_link",
  "GET /api/v2.1/upload-links/": "list_upload_links",
  "POST /api/v2.1/upload-links/": "create_upload_link",
  "DELETE /api/v2.1/upload-links/{token}/": "delete_upload_link",
};

/** @type {Record<string, string>} */
const DESCRIPTIONS = {
  "GET /api2/ping/": "Ping the Seafile server. No library access.",
  "GET /api2/auth/ping/": "Ping with the account token. Confirms the token is accepted.",
  "GET /api2/server-info/": "Read server version and feature flags.",
  "GET /api2/account/info/": "Read the account behind SEAFILE_TOKEN. The connector does not store a password.",
  "POST /api2/auth-token/":
    "Mint an account token. Credential-minting write. Output token is redacted. Prefer setting SEAFILE_TOKEN outside this connector.",
  "GET /api2/repos/": "List libraries visible to the token.",
  "POST /api2/repos/":
    "Create a library. Form body field name is required. Encrypted libraries need passwd. The sync token in the response is redacted.",
  "GET /api2/repos/{repo_id}/": "Read one library.",
  "DELETE /api2/repos/{repo_id}/": "Delete a library. Destructive. The preview names repo_id.",
  "POST /api2/repos/{repo_id}/":
    "Library password or rename. Query op is rename, setpassword, or checkpassword. Form fields repo_name and repo_desc for rename.",
  "GET /api2/repos/{repo_id}/dir/":
    "List a directory. Query p is the directory path. p defaults to / on the server.",
  "POST /api2/repos/{repo_id}/dir/":
    "Create, rename, or move a directory. Query p is the path. Form operation is mkdir, rename, or move.",
  "DELETE /api2/repos/{repo_id}/dir/": "Delete a directory. Query p is the path. Destructive.",
  "GET /api2/repos/{repo_id}/file/":
    "Mint a file download URL. Query p is the file path. Side-effect GET. The URL token is redacted.",
  "POST /api2/repos/{repo_id}/file/":
    "Create, rename, move, or copy a file. Query p is the path. Form operation is create, rename, move, or copy.",
  "DELETE /api2/repos/{repo_id}/file/": "Delete a file into library trash. Query p is the path. Destructive.",
  "PUT /api2/repos/{repo_id}/file/": "Lock or unlock a file. Body operation is lock or unlock. Body p is the path.",
  "GET /api2/repos/{repo_id}/file/detail/": "Read file detail for query p.",
  "GET /api2/repos/{repo_id}/upload-link/":
    "Mint a file-server upload URL for query p. Side-effect GET. replace=1 allows overwrite.",
  "GET /api2/repos/{repo_id}/update-link/": "Mint a file-server update URL for an existing file. Side-effect GET.",
  "GET /api2/search/": "Search libraries. Query q is the text.",
  "GET /api/v2.1/search-file/": "Search file names and content. Query q is the text.",
  "GET /api/v2.1/repos/{repo_id}/trash/": "List library trash.",
  "DELETE /api/v2.1/repos/{repo_id}/trash/": "Empty library trash. Destructive.",
  "POST /api/v2.1/repos/{repo_id}/trash/": "Restore items from library trash.",
  "PUT /api2/repos/{repo_id}/file/revert/": "Revert a file to an older commit. Destructive.",
  "PUT /api2/repos/{repo_id}/dir/revert/": "Revert a directory. Destructive.",
  "GET /api/v2.1/share-links/": "List share links for the account.",
  "POST /api/v2.1/share-links/":
    "Create a share link. Credential-minting. Body repo_id and path. The link token is redacted.",
  "DELETE /api/v2.1/share-links/{token}/": "Delete a share link. Destructive.",
  "GET /api/v2.1/upload-links/": "List upload links.",
  "POST /api/v2.1/upload-links/": "Create an upload link. Credential-minting. The token is redacted.",
  "DELETE /api/v2.1/upload-links/{token}/": "Delete an upload link. Destructive.",
  "GET /api/v2.1/repos/{repo_id}/repo-api-tokens/": "List library API tokens. Token values are redacted.",
  "POST /api/v2.1/repos/{repo_id}/repo-api-tokens/":
    "Create a library API token. Credential-minting. Library tokens cannot delete, move, or copy.",
  "PUT /api/v2.1/webdav-secret/": "Rotate the WebDAV secret. Credential-minting. The secret is redacted.",
  "GET /api/v2.1/webdav-secret/": "Read the WebDAV secret. Side-effect style credential read. The secret is redacted.",
};

/**
 * @param {string} value
 */
function slug(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

/**
 * @param {string} path
 */
function segments(path) {
  return path.split("/").filter(Boolean);
}

/**
 * @param {string} path
 */
function staticParts(path) {
  return segments(path)
    .filter((part) => !part.startsWith("{"))
    .filter((part) => part !== "api" && part !== "api2" && part !== "v2.1")
    .map((part) => slug(part));
}

/**
 * @param {string} path
 */
function paramNames(path) {
  /** @type {string[]} */
  const names = [];
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * @param {string} path
 */
function lastStatic(path) {
  const parts = segments(path).filter((part) => !part.startsWith("{"));
  return parts[parts.length - 1] ?? "";
}

/**
 * @param {string} path
 */
function sideEffectGet(path) {
  const value = path.toLowerCase();
  if (value.includes("auth-token")) return true;
  if (value.includes("webdav-secret")) return true;
  if (value.includes("generate-user-auth-token")) return true;
  if (value.includes("repo-notification-jwt-token")) return true;
  if (value.includes("client-sso-link")) return true;
  if (/\/repo-tokens\/?$/.test(value)) return true;
  if (/\/(upload-link|update-link|download-link|upload-blks-link|update-blks-link)\/?$/.test(value)) {
    return true;
  }
  if (/\/file\/?$/.test(value)) return true;
  if (value.includes("/upload/") && (value.includes("share-link") || value.includes("upload-link"))) {
    return true;
  }
  return false;
}

/**
 * @param {string} method
 * @param {string} path
 */
function isWrite(method, path) {
  return method !== "GET" || sideEffectGet(path);
}

/**
 * @param {string} path
 */
function adminToolset(path) {
  const rest = path.replace(/^\/api\/v2\.1\/admin\//, "").replace(/^\/api2\/admin\//, "");
  const head = rest.split("/")[0] ?? "";
  if (["users", "admin-users", "admin-role", "search-user", "generate-user-auth-token"].includes(head)) {
    return "admin_users";
  }
  if (["libraries", "trash-libraries", "system-library", "default-library", "search-library"].includes(head)) {
    return "admin_libraries";
  }
  if (["groups", "search-group"].includes(head)) return "admin_groups";
  if (["logs", "statistics", "devices", "device-errors", "device-trusted-ip"].includes(head)) {
    return "admin_logs";
  }
  if (["share-links", "upload-links", "shares"].includes(head)) return "admin_shares";
  return "admin_system";
}

/**
 * @param {string} path
 */
function isShareProduct(path) {
  return /share-links|shared-links|send-share-link|smart-links?|download-shared-links|file\/shared-link/.test(
    path,
  );
}

/**
 * @param {string} path
 */
function isUploadProduct(path) {
  return /upload-links|upload-shared-links|shared-upload-links|send-upload-link/.test(path);
}

/**
 * @param {string} path
 */
function isSearch(path) {
  if (path.includes("/admin/")) return false;
  if (path.includes("search-member")) return false;
  if (path.includes("/address-book/")) return false;
  if (path.includes("/trash")) return false;
  if (path.includes("/via-repo-token/")) return false;
  return /\/(search|items-search|search-user|search-file|search-group|published-repo-search)\/?$/.test(path);
}

/**
 * @param {string} path
 */
function isHistory(path) {
  if (path.includes("history-limit")) return false;
  return /trash|\/history\/|revert|deleted-repos|repo_history_changes|\/commits\/|file\/revision|file\/access-log|file\/new_history/.test(
    path,
  );
}

/**
 * @param {string} path
 */
function isSharing(path) {
  return /shared-repos|beshared-repos|shared_items|folder-perm|custom-share-permissions|shared-folders|repo-folder-share-info|\/share-info|dir\/sub_repo|shared\/invitation/.test(
    path,
  );
}

/**
 * @param {string} path
 */
function isGroup(path) {
  return /\/groups|group-owned-libraries|all-groups|shareable-groups|group-members-import/.test(path);
}

/**
 * @param {string} path
 */
function isTags(path) {
  return /revision-tags|repo-tags|file-tags|tagged-files|\/tags\/|\/tags$/.test(path);
}

/**
 * @param {string} path
 */
function isFile(path) {
  return /\/file\/|\/dir\/|fileops|batch-copy|batch-move|batch-delete|batch-create|batch-lock|batch-unlock|async-batch|sync-batch|thumbnail|owa-file|image-rotate|office-suite|zip-task|\/comments|participant|related-users|file-uploaded-bytes|copy-move-task|query-zip-progress|cancel-zip-task|query-copy-move-progress|move-folder-merge|recent-added-files|related-files|upload-link|update-link|download-link|upload-blks|update-blks/.test(
    path,
  );
}

/**
 * @param {string} path
 */
function isLibrary(path) {
  return /\/repos\/?$|\/repos\/\{repo_id\}\/?$|\/repos\/public|default-repo|monitored-repos|history-limit|\/set-password|\/send-new-password|download-info|\/archive\/?$|repo-api-tokens|webhooks|repo-notification-jwt|\/repo-tokens/.test(
    path,
  );
}

/**
 * @param {string} path
 */
function toolsetFor(path) {
  if (path.startsWith("/api/v2.1/admin/") || path.startsWith("/api2/admin/")) return adminToolset(path);
  if (path.includes("/via-repo-token")) return "via_repo_token";
  if (/wiki2|\/wikis|convert-wiki|import-confluence/.test(path)) return "wikis";
  if (isShareProduct(path)) return "share_links";
  if (isUploadProduct(path)) return "upload_links";
  if (path.includes("/ocm/")) return "ocm";
  if (path.includes("/address-book") || path.includes("/departments")) return "address_book";
  if (path.includes("/activities")) return "activities";
  if (path.includes("notification")) return "notifications";
  if (path.includes("starred")) return "starred";
  if (isTags(path)) return "tags";
  if (isSearch(path)) return "search";
  if (isHistory(path)) return "history_trash";
  if (isSharing(path)) return "library_sharing";
  if (path.includes("/invitations")) return "invitations";
  if (isGroup(path)) return "groups";
  if (isFile(path)) return "files_and_dirs";
  if (isLibrary(path) || path.includes("/repos/")) return "libraries";
  return "server";
}

/**
 * @param {string} method
 * @param {string} path
 */
function verbFor(method, path) {
  const last = slug(lastStatic(path));
  const trailingParam = /\{[^}]+\}\/?$/.test(path);
  if (method === "DELETE") return "delete";
  if (method === "PUT") {
    if (["revert", "rename", "lock", "unlock", "clean"].includes(last)) return last;
    return "update";
  }
  if (method === "POST") {
    if (["revert", "copy", "move", "rename"].includes(last)) return last;
    if (!trailingParam && /s$/.test(last) && !last.endsWith("ss")) return "create";
    return "post";
  }
  if (!trailingParam && /s$/.test(last) && !/info|status|limit/.test(last)) return "list";
  return "get";
}

/**
 * @param {string} verb
 * @param {string[]} parts
 */
function compactAction(verb, parts) {
  const kept = parts.flatMap((part) => {
    if (part === verb) return [];
    if (part.startsWith(`${verb}_`)) return [part.slice(verb.length + 1)];
    return [part];
  });
  const action = [verb, ...kept].filter(Boolean).join("_");
  return action.length > 0 ? action : verb;
}

/**
 * @param {string} method
 * @param {string} path
 */
function actionFrom(method, path) {
  const key = `${method} ${path}`;
  const override = ACTION_OVERRIDES[key];
  if (override !== undefined) return override;
  return compactAction(verbFor(method, path), staticParts(path));
}

/**
 * @param {string} name
 */
function sampleFor(name) {
  if (name === "email" || name.endsWith("_email") || name === "user") return "user@example.com";
  if (name === "token") return "link-sample";
  if (name.endsWith("_id") || name === "id") return `${slug(name)}-sample`;
  return `${slug(name)}-sample`;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {boolean} write
 */
function warningsFor(method, path, write) {
  if (!write) return [];
  /** @type {string[]} */
  const out = [];
  const value = path.toLowerCase();
  if (
    method === "DELETE" ||
    /revert|trash|expire|purge|wipe|clean-invalid|device-wiped/.test(value)
  ) {
    out.push(DESTRUCTIVE_WARNING);
  }
  if (
    sideEffectGet(path) ||
    /auth-token|webdav-secret|repo-api-token|repo-tokens|share-link|upload-link|download-link|update-link|sso-link|jwt-token|folder-perm|permission|passwd|password|secret/.test(
      value,
    )
  ) {
    out.push(CREDENTIAL_WARNING);
  }
  if (/move|copy/.test(value)) out.push(MOVE_WARNING);
  if (method !== "GET" && /public|publish|perm|policy/.test(value)) out.push(EXPOSURE_WARNING);
  return [...new Set(out)];
}

/**
 * @param {string} method
 * @param {string} path
 */
function summaryFor(method, path, view) {
  const key = `${method} ${path}`;
  const curated = DESCRIPTIONS[key];
  if (curated !== undefined) return curated;
  const params = paramNames(path);
  const paramNote = params.length > 0 ? ` Path params: ${params.join(", ")}.` : "";
  return `${method} ${path} (${view}).${paramNote} Body and query are free-form.`;
}

/**
 * @param {string} path
 */
function encodingFor(path) {
  return path.startsWith("/api2/") ? "form" : "json";
}

/** @type {object[]} */
const rows = [];
/** @type {Map<string, string>} */
const seenActions = new Map();

for (const route of routes) {
  const method = String(route.method || "").toUpperCase();
  const path = String(route.path || "");
  const view = String(route.view || "");
  if (!["GET", "POST", "PUT", "DELETE"].includes(method) || path.length === 0) {
    throw new Error(`Bad route ${method} ${path}`);
  }
  const toolset = toolsetFor(path);
  let action = actionFrom(method, path);
  if (!/^[a-z][a-z0-9_]*$/.test(action)) {
    throw new Error(`Bad action ${action} for ${method} ${path}`);
  }
  const actionKey = `${toolset}::${action}`;
  if (seenActions.has(actionKey)) {
    const extra = paramNames(path).map((name) => slug(name)).join("_");
    const candidate = extra.length > 0 ? `${action}_${extra}` : `${action}_${method.toLowerCase()}`;
    action = seenActions.has(`${toolset}::${candidate}`)
      ? `${action}_${method.toLowerCase()}_${rows.length}`
      : candidate;
  }
  seenActions.set(`${toolset}::${action}`, `${method} ${path}`);
  const names = paramNames(path);
  /** @type {Record<string, string>} */
  const sampleParams = {};
  for (const name of names) sampleParams[name] = sampleFor(name);
  const write = isWrite(method, path);
  rows.push({
    method,
    path,
    action,
    tool: `seafile_${toolset}`,
    toolset,
    tag: view,
    operationId: action,
    write,
    destructive:
      method === "DELETE" ||
      /revert|clean-invalid|device-wiped|expire|purge/.test(path.toLowerCase()) ||
      (path.toLowerCase().includes("trash") && method === "DELETE"),
    credential: warningsFor(method, path, write).includes(CREDENTIAL_WARNING),
    encoding: encodingFor(path),
    summary: summaryFor(method, path, view),
    pathParams: names,
    warnings: warningsFor(method, path, write),
    sampleParams,
  });
}

rows.sort((a, b) => {
  const tool = a.tool.localeCompare(b.tool);
  if (tool !== 0) return tool;
  const action = a.action.localeCompare(b.action);
  if (action !== 0) return action;
  return `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`);
});

const toolsets = [...new Set(rows.map((row) => row.toolset))].sort();
for (const name of DEFAULT_TOOLSETS) {
  if (!toolsets.includes(name)) throw new Error(`Missing default toolset ${name}`);
}

/** @type {Record<string, { operations: number, tags: string[] }>} */
const counts = {};
for (const toolset of toolsets) {
  const subset = rows.filter((row) => row.toolset === toolset);
  counts[toolset] = {
    operations: subset.length,
    tags: [...new Set(subset.map((row) => row.tag))].sort(),
  };
}

if (rows.length !== routes.length) {
  throw new Error(`Generated ${rows.length} rows from ${routes.length} routes`);
}

/**
 * @param {unknown} value
 */
function ts(value) {
  return JSON.stringify(value);
}

/**
 * @param {object} row
 */
function emitRow(row) {
  const options = [
    `action: ${ts(row.action)}`,
    `toolset: ${ts(row.toolset)}`,
    `tag: ${ts(row.tag)}`,
    `operationId: ${ts(row.operationId)}`,
    `write: ${row.write}`,
    `destructive: ${row.destructive}`,
    `credential: ${row.credential}`,
    `encoding: ${ts(row.encoding)}`,
    `summary: ${ts(row.summary)}`,
    `pathParams: ${ts(row.pathParams)}`,
    `warnings: ${ts(row.warnings)}`,
    `sampleParams: ${ts(row.sampleParams)}`,
  ];
  return `  row(${ts(row.method)}, ${ts(row.path)}, ${ts(row.tool)}, {\n    ${options.join(",\n    ")},\n  })`;
}

const header = `/** Generated by scripts/gen-operations.mjs from seafile.routes.json. Do not edit by hand. */

import { ConnectorError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type BodyEncoding = "json" | "form";

export interface Operation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly tool: string;
  readonly action: string;
  readonly toolset: string;
  readonly tag: string;
  readonly operationId: string;
  readonly write: boolean;
  readonly destructive: boolean;
  readonly credential: boolean;
  readonly encoding: BodyEncoding;
  readonly summary: string;
  readonly pathParams: readonly string[];
  readonly warnings: readonly string[];
  readonly sampleParams: Readonly<Record<string, string>>;
}

function row(
  method: HttpMethod,
  path: string,
  tool: string,
  options: {
    action: string;
    toolset: string;
    tag: string;
    operationId: string;
    write: boolean;
    destructive: boolean;
    credential: boolean;
    encoding: BodyEncoding;
    summary: string;
    pathParams: readonly string[];
    warnings: readonly string[];
    sampleParams: Readonly<Record<string, string>>;
  },
): Operation {
  return {
    method,
    path,
    tool,
    action: options.action,
    toolset: options.toolset,
    tag: options.tag,
    operationId: options.operationId,
    write: options.write,
    destructive: options.destructive,
    credential: options.credential,
    encoding: options.encoding,
    summary: options.summary,
    pathParams: options.pathParams,
    warnings: options.warnings,
    sampleParams: options.sampleParams,
  };
}

export const DEFAULT_TOOLSETS = ${ts(DEFAULT_TOOLSETS)} as const;

export const ALL_TOOLSETS = ${ts(toolsets)} as const;

export const TOOLSET_COUNTS: Readonly<
  Record<string, { readonly operations: number; readonly tags: readonly string[] }>
> = ${ts(counts)};

export const OPERATIONS: readonly Operation[] = [
${rows.map(emitRow).join(",\n")},
];

export function toolNames(): string[] {
  return [...new Set(OPERATIONS.map((operation) => operation.tool))].sort();
}

export function operationsForTool(name: string): Operation[] {
  return OPERATIONS.filter((operation) => operation.tool === name);
}

export function toolIsWrite(name: string): boolean {
  return OPERATIONS.some((operation) => operation.tool === name && operation.write);
}

export function routeKeys(): string[] {
  return OPERATIONS.map((operation) => \`\${operation.method} \${operation.path}\`).sort();
}

export function requireOp(tool: string, action: string): Operation {
  const found = OPERATIONS.find((operation) => operation.tool === tool && operation.action === action);
  if (found === undefined) {
    throw new ConnectorError("input", \`Unknown Seafile operation \${tool} \${action}.\`);
  }
  return found;
}

export function parseToolsets(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_TOOLSETS];
  const trimmed = raw.trim();
  if (trimmed === "all") return [...ALL_TOOLSETS];
  const wanted = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const allowed = new Set<string>(ALL_TOOLSETS);
  const unknown = wanted.filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new ConnectorError("config", "Unknown SEAFILE_TOOLSETS value.");
  }
  return [...new Set(wanted)];
}

export function toolsForToolsets(enabled: readonly string[]): string[] {
  const allow = new Set(enabled);
  return toolNames().filter((name) => {
    const operation = OPERATIONS.find((item) => item.tool === name);
    return operation !== undefined && allow.has(operation.toolset);
  });
}
`;

writeFileSync(join(root, "src/operations.ts"), header);
console.log(
  `wrote src/operations.ts (${rows.length} operations, ${toolsets.length} toolsets)`,
);
for (const toolset of toolsets) {
  console.log(`${counts[toolset].operations.toString().padStart(4)} ${toolset}`);
}
