#!/usr/bin/env node
/**
 * Live check against a real self-hosted Seafile server. Spawns dist/index.js over stdio.
 * Skips when SEAFILE_URL or SEAFILE_TOKEN is unset. Does not print the token.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const token = process.env["SEAFILE_TOKEN"] ?? "";
const baseUrl = process.env["SEAFILE_URL"] ?? "";
const fileServer = process.env["SEAFILE_FILE_SERVER_URL"] ?? "";

/** @type {string[]} */
const secrets = [];
if (token.length >= 8) secrets.push(token);

/**
 * @param {string} text
 */
function redact(text) {
  let out = String(text);
  for (const secret of secrets) {
    out = out.split(secret).join("[redacted]");
    out = out.split(encodeURIComponent(secret)).join("[redacted]");
  }
  out = out.replace(/(authorization:\s*(?:bearer|token)\s+)\S+/gi, "Authorization: Token [redacted]");
  out = out.replace(
    /"(token|password|passwd|pwd_hash|pwd_hash_algo|pwd_hash_params|magic|random_key|secret|webdav_passwd)"\s*:\s*"[^"]*"/gi,
    '"$1":"[redacted]"',
  );
  out = out.replace(/(\/(?:f|d|u\/d|upload-api|update-api|files|zip)\/)[A-Za-z0-9_-]{8,}/g, "$1[redacted]");
  return out;
}

/**
 * @param {string} text
 */
function clip(text) {
  let shortened = redact(text).replace(/\s+/g, " ").trim();
  if (shortened.length > 180) shortened = `${shortened.slice(0, 177)}...`;
  return shortened;
}

const writeLine = console.log.bind(console);
const writeError = console.error.bind(console);
console.log = (line) => writeLine(redact(String(line)));
console.error = (line) => writeError(redact(String(line)));

let failed = 0;
/** @type {string[]} */
const rows = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 */
function record(name, ok, detail) {
  if (!ok) failed += 1;
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}  ${clip(detail)}`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {string | undefined}
 */
function firstId(value, keys) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstId(item, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string" && entry.length > 0 && entry !== "[redacted]") return entry;
  }
  for (const nested of Object.values(value)) {
    const found = firstId(nested, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const block = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = block && typeof block === "object" && "text" in block ? String(block.text) : "";
  if (token.length >= 8 && (text.includes(token) || text.includes(encodeURIComponent(token)))) {
    throw new Error("secret leaked into tool output");
  }
  /** @type {Record<string, unknown> | null} */
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: result.isError === true, text, json };
}

/**
 * @param {Record<string, unknown> | null} json
 */
function repoIdFrom(json) {
  if (!isRecord(json)) return undefined;
  return firstId(json["result"], ["repo_id"]) ?? firstId(json, ["repo_id"]);
}

async function main() {
  if (baseUrl.trim().length === 0 || token.trim().length < 8) {
    writeLine("SKIP  live-check  SEAFILE_URL and SEAFILE_TOKEN are unset.");
    return;
  }

  const childEnv = { ...process.env };
  delete childEnv["DATABASE_URL"];
  childEnv["SEAFILE_URL"] = baseUrl;
  childEnv["SEAFILE_TOKEN"] = token;
  childEnv["SEAFILE_ALLOW_WRITES"] = "true";
  childEnv["SEAFILE_TOOLSETS"] = "all";
  childEnv["SEAFILE_CACHE_TTL_SEC"] = "0";
  childEnv["SEAFILE_PER_MINUTE"] = "600";
  if (fileServer.trim().length > 0) childEnv["SEAFILE_FILE_SERVER_URL"] = fileServer;

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: root,
    env: childEnv,
    stderr: "pipe",
  });
  const client = new Client({ name: "seafile-live-check", version: "0" });
  await client.connect(transport);

  const stamp = Date.now().toString(36);
  const libraryName = `mcp-live-${stamp}`.slice(0, 40);
  const notePath = "/mcp-live-note.txt";
  const noteText = `mcp-live ${stamp}`;
  /** @type {string | undefined} */
  let repoId;

  /**
   * @param {string} id
   */
  async function deleteRepo(id) {
    return call(client, "seafile_libraries", {
      action: "delete_repo",
      params: { repo_id: id },
      confirm: true,
    });
  }

  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    record(
      "list_tools",
      names.includes("seafile_server") &&
        names.includes("seafile_libraries") &&
        names.includes("seafile_files_and_dirs") &&
        names.includes("seafile_admin_users") &&
        names.length >= 20,
      `${names.length} tools`,
    );

    const ping = await call(client, "seafile_server", { action: "ping" });
    record("seafile_server ping", !ping.isError, ping.text);

    const info = await call(client, "seafile_server", { action: "server_info" });
    record("seafile_server server_info", !info.isError, info.text);

    const account = await call(client, "seafile_server", { action: "account_info" });
    record("seafile_server account_info", !account.isError, account.text);

    const repos = await call(client, "seafile_libraries", { action: "list_repos" });
    record("seafile_libraries list_repos", !repos.isError, repos.text);

    const createPreview = await call(client, "seafile_libraries", {
      action: "create_repo",
      body: { name: libraryName },
    });
    record(
      "seafile_libraries create_repo preview",
      !createPreview.isError && createPreview.json?.["executed"] === false && createPreview.json?.["dry_run"] === true,
      createPreview.text,
    );

    const created = await call(client, "seafile_libraries", {
      action: "create_repo",
      body: { name: libraryName },
      confirm: true,
    });
    repoId = repoIdFrom(created.json);
    record(
      "seafile_libraries create_repo confirm",
      !created.isError && repoId !== undefined && !created.text.includes("token:"),
      created.text,
    );

    if (repoId !== undefined) {
      const got = await call(client, "seafile_libraries", {
        action: "get_repo",
        params: { repo_id: repoId },
      });
      record("seafile_libraries get_repo", !got.isError, got.text);

      const dirPreview = await call(client, "seafile_files_and_dirs", {
        action: "post_dir",
        params: { repo_id: repoId },
        query: { p: "/mcp-live" },
        body: { operation: "mkdir" },
      });
      record(
        "seafile_files_and_dirs post_dir preview",
        !dirPreview.isError &&
          dirPreview.json?.["executed"] === false &&
          String(dirPreview.text).includes(repoId) &&
          String(dirPreview.text).includes("/mcp-live"),
        dirPreview.text,
      );

      const dirMade = await call(client, "seafile_files_and_dirs", {
        action: "post_dir",
        params: { repo_id: repoId },
        query: { p: "/mcp-live" },
        body: { operation: "mkdir" },
        confirm: true,
      });
      record("seafile_files_and_dirs post_dir confirm", !dirMade.isError, dirMade.text);

      const listedDir = await call(client, "seafile_files_and_dirs", {
        action: "list_dir",
        params: { repo_id: repoId },
        query: { p: "/" },
      });
      record("seafile_files_and_dirs list_dir", !listedDir.isError, listedDir.text);

      const writePreview = await call(client, "seafile_files_and_dirs", {
        action: "write_text_file",
        params: { repo_id: repoId },
        query: { p: notePath },
        body: { text: noteText },
      });
      record(
        "seafile_files_and_dirs write_text_file preview",
        !writePreview.isError &&
          writePreview.json?.["executed"] === false &&
          String(writePreview.text).includes(repoId) &&
          String(writePreview.text).includes(notePath),
        writePreview.text,
      );

      const wrote = await call(client, "seafile_files_and_dirs", {
        action: "write_text_file",
        params: { repo_id: repoId },
        query: { p: notePath },
        body: { text: noteText },
        confirm: true,
      });
      record("seafile_files_and_dirs write_text_file confirm", !wrote.isError, wrote.text);

      const readPreview = await call(client, "seafile_files_and_dirs", {
        action: "read_text_file",
        params: { repo_id: repoId },
        query: { p: notePath },
      });
      record(
        "seafile_files_and_dirs read_text_file preview",
        !readPreview.isError && readPreview.json?.["executed"] === false,
        readPreview.text,
      );

      const read = await call(client, "seafile_files_and_dirs", {
        action: "read_text_file",
        params: { repo_id: repoId },
        query: { p: notePath },
        confirm: true,
      });
      record(
        "seafile_files_and_dirs read_text_file confirm",
        !read.isError && read.text.includes(noteText),
        read.text,
      );

      const linkPreview = await call(client, "seafile_files_and_dirs", {
        action: "get_upload_link",
        params: { repo_id: repoId },
        query: { p: "/" },
      });
      record(
        "seafile_files_and_dirs get_upload_link preview",
        !linkPreview.isError && linkPreview.json?.["executed"] === false,
        linkPreview.text,
      );

      const link = await call(client, "seafile_files_and_dirs", {
        action: "get_upload_link",
        params: { repo_id: repoId },
        query: { p: "/" },
        confirm: true,
      });
      record(
        "seafile_files_and_dirs get_upload_link confirm",
        !link.isError && link.text.includes("[redacted]"),
        link.text,
      );

      const sharePreview = await call(client, "seafile_share_links", {
        action: "create_share_link",
        body: { repo_id: repoId, path: notePath },
      });
      record(
        "seafile_share_links create_share_link preview",
        !sharePreview.isError && sharePreview.json?.["executed"] === false,
        sharePreview.text,
      );

      const share = await call(client, "seafile_share_links", {
        action: "create_share_link",
        body: { repo_id: repoId, path: notePath },
        confirm: true,
      });
      const shareOk = !share.isError && (share.text.includes("[redacted]") || share.text.includes("repo_id"));
      record("seafile_share_links create_share_link confirm", shareOk, share.text);

      const search = await call(client, "seafile_search", {
        action: "search_file",
        query: { q: "mcp-live" },
      });
      const searchClean =
        !search.isError ||
        /\[(not-found|invalid|server|forbidden|unauthorized)\]/.test(search.text);
      record("seafile_search search_file", searchClean, search.text);

      const deletePreview = await call(client, "seafile_files_and_dirs", {
        action: "delete_file",
        params: { repo_id: repoId },
        query: { p: notePath },
      });
      record(
        "seafile_files_and_dirs delete_file preview",
        !deletePreview.isError &&
          deletePreview.json?.["executed"] === false &&
          String(deletePreview.text).includes(`Target library ${repoId} path ${notePath}`),
        deletePreview.text,
      );

      const deletedFile = await call(client, "seafile_files_and_dirs", {
        action: "delete_file",
        params: { repo_id: repoId },
        query: { p: notePath },
        confirm: true,
      });
      record("seafile_files_and_dirs delete_file confirm", !deletedFile.isError, deletedFile.text);

      const trash = await call(client, "seafile_history_trash", {
        action: "list_trash",
        params: { repo_id: repoId },
      });
      record("seafile_history_trash list_trash", !trash.isError, trash.text);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "live-check failed";
    record("live-check", false, message);
  } finally {
    if (repoId !== undefined) {
      try {
        const preview = await call(client, "seafile_libraries", {
          action: "delete_repo",
          params: { repo_id: repoId },
        });
        record(
          "seafile_libraries delete_repo preview",
          !preview.isError && preview.json?.["executed"] === false && String(preview.text).includes(repoId),
          preview.text,
        );
        const deleted = await deleteRepo(repoId);
        record("seafile_libraries delete_repo confirm", !deleted.isError, deleted.text);
      } catch {
        record("seafile_libraries delete_repo confirm", false, "cleanup failed");
      }
    }
    await client.close();
  }

  for (const row of rows) writeLine(row);
  writeLine(`failed=${failed}`);
  if (failed > 0) process.exit(1);
}

await main();
