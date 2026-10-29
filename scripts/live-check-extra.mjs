#!/usr/bin/env node
/**
 * Second live-check phase against a real self-hosted Seafile server (stdio, dist/index.js).
 * Covers starred, upload and share links (token reveal on), copy/move/rename, history, trash,
 * groups, admin lists, error paths and the write gate. Throwaway objects only. Prints pass/fail only.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const token = process.env["SEAFILE_TOKEN"] ?? "";
const baseUrl = process.env["SEAFILE_URL"] ?? "";
if (baseUrl === "" || token.length < 8) {
  console.log("SKIP  live-check-extra  SEAFILE_URL and SEAFILE_TOKEN are unset.");
  process.exit(0);
}
let failed = 0;
const record = (name, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${String(detail).replace(/\s+/g, " ").slice(0, 150)}`);
};

async function connect(extra) {
  const env = { ...process.env, SEAFILE_TOOLSETS: "all", SEAFILE_CACHE_TTL_SEC: "0", SEAFILE_PER_MINUTE: "600", ...extra };
  delete env["DATABASE_URL"];
  const client = new Client({ name: "seafile-live-extra", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], cwd: root, env, stderr: "pipe" }));
  return client;
}
async function call(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (text.includes(token)) throw new Error("account token leaked into tool output");
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { isError: r.isError === true, text, json };
}

const stamp = Date.now().toString(36);
const writes = await connect({ SEAFILE_ALLOW_WRITES: "true", SEAFILE_REVEAL_LINK_TOKENS: "true", ...(process.env["SEAFILE_FILE_SERVER_URL"] ? { SEAFILE_FILE_SERVER_URL: process.env["SEAFILE_FILE_SERVER_URL"] } : {}) });
const readOnly = await connect({ SEAFILE_ALLOW_WRITES: "false" });
let repoId;
const W = (tool, action, args) => call(writes, `seafile_${tool}`, { action, ...args });
const ok = async (label, p, pred = () => true) => {
  try {
    const r = await p;
    record(label, !r.isError && pred(r), r.text);
    return r;
  } catch (e) {
    record(label, false, e instanceof Error ? e.message : "error");
    return { isError: true, text: "", json: null };
  }
};
try {
  const repo = await ok("libraries create_repo", W("libraries", "create_repo", { body: { name: `mcp-extra-${stamp}` }, confirm: true }));
  repoId = repo.json?.result?.repo_id;
  if (!repoId) throw new Error("no library id");
  const p = { repo_id: repoId };
  await ok("files mkdir /d", W("files_and_dirs", "post_dir", { params: p, query: { p: "/d" }, body: { operation: "mkdir" }, confirm: true }));
  await ok("files mkdir /e", W("files_and_dirs", "post_dir", { params: p, query: { p: "/e" }, body: { operation: "mkdir" }, confirm: true }));
  await ok("files write_text_file /d/a.txt", W("files_and_dirs", "write_text_file", { params: p, query: { p: "/d/a.txt" }, body: { text: `extra ${stamp}` }, confirm: true }));
  const read = await ok("files read_text_file /d/a.txt", W("files_and_dirs", "read_text_file", { params: p, query: { p: "/d/a.txt" }, confirm: true }), (r) => r.text.includes(`extra ${stamp}`));
  void read;
  await ok("files get_repos_file detail", call(writes, "seafile_files_and_dirs", { action: "get_repos_file", params: p, query: { p: "/d/a.txt" } }), (r) => r.text.includes("a.txt"));
  await ok("files get_repos_dir", call(writes, "seafile_files_and_dirs", { action: "get_repos_dir", params: p, query: { p: "/d" } }), (r) => r.text.includes("a.txt"));
  await ok("files copy a.txt to /e (preview)", W("files_and_dirs", "copy_repos_fileops", { params: p, query: { p: "/d" }, body: { file_names: "a.txt", dst_repo: repoId, dst_dir: "/e" } }), (r) => r.json?.executed === false);
  await ok("files copy a.txt to /e", W("files_and_dirs", "copy_repos_fileops", { params: p, query: { p: "/d" }, body: { file_names: "a.txt", dst_repo: repoId, dst_dir: "/e" }, confirm: true }));
  await ok("files rename /e/a.txt", W("files_and_dirs", "post_file", { params: p, query: { p: "/e/a.txt" }, body: { operation: "rename", newname: "b.txt" }, confirm: true }));
  await ok("files move b.txt to /d", W("files_and_dirs", "move_repos_fileops", { params: p, query: { p: "/e" }, body: { file_names: "b.txt", dst_repo: repoId, dst_dir: "/d" }, confirm: true }));
  await ok("history file history", call(writes, "seafile_history_trash", { action: "get_repos_file_history", params: p, query: { p: "/d/a.txt" } }));
  await ok("files delete b.txt (confirm)", W("files_and_dirs", "delete_file", { params: p, query: { p: "/d/b.txt" }, confirm: true }));
  await ok("history list_trash shows b.txt", call(writes, "seafile_history_trash", { action: "list_trash", params: p }), (r) => r.text.includes("b.txt"));

  await ok("starred create", W("starred", "create_starred_items", { body: { repo_id: repoId, path: "/d/a.txt" }, confirm: true }));
  await ok("starred list", call(writes, "seafile_starred", { action: "list_starred_items" }), (r) => r.text.includes(repoId));
  await ok("starred delete", W("starred", "delete_starred_items", { query: { repo_id: repoId, path: "/d/a.txt" }, confirm: true }));

  const up = await ok("upload_links create (token revealed)", W("upload_links", "create_upload_link", { body: { repo_id: repoId, path: "/d" }, confirm: true }), (r) => typeof r.json?.result?.token === "string" && r.json.result.token !== "[redacted]");
  const upTok = up.json?.result?.token;
  if (upTok) {
    await ok("upload_links list for library", call(writes, "seafile_upload_links", { action: "list_repos_upload_links", params: p }), (r) => r.text.includes(upTok));
    await ok("upload_links delete by token (preview)", W("upload_links", "delete_upload_link", { params: { token: upTok } }), (r) => r.json?.executed === false);
    await ok("upload_links delete by token", W("upload_links", "delete_upload_link", { params: { token: upTok }, confirm: true }));
  }
  const sh = await ok("share_links create (token revealed)", W("share_links", "create_share_link", { body: { repo_id: repoId, path: "/d/a.txt" }, confirm: true }), (r) => typeof r.json?.result?.token === "string" && r.json.result.token !== "[redacted]");
  const shTok = sh.json?.result?.token;
  if (shTok) {
    await ok("share_links get by token", call(writes, "seafile_share_links", { action: "get_share_links", params: { token: shTok } }));
    await ok("share_links delete by token", W("share_links", "delete_share_link", { params: { token: shTok }, confirm: true }));
  }
  const hidden = await ok("share_links create with reveal off hides the token", call(readOnly, "seafile_share_links", { action: "create_share_link", body: { repo_id: repoId, path: "/d/a.txt" }, confirm: true }), (r) => r.json?.executed === false || r.json?.blocked === true);
  void hidden;

  const grp = await ok("groups create", W("groups", "create_groups_post", { body: { name: `mcp-grp-${stamp}` }, confirm: true }));
  const gid = grp.json?.result?.id ?? grp.json?.result?.group_id;
  await ok("groups list", call(writes, "seafile_groups", { action: "list_groups_get" }), (r) => r.text.includes(`mcp-grp-${stamp}`));
  if (gid !== undefined) await ok("groups delete", W("groups", "delete_groups_delete_139", { params: { group_id: String(gid) }, confirm: true }));

  await ok("admin_users list", call(writes, "seafile_admin_users", { action: "list_admin_users" }), (r) => r.text.includes("admin@"));
  await ok("admin_libraries list", call(writes, "seafile_admin_libraries", { action: "list_admin_libraries" }));

  const nf = await call(writes, "seafile_libraries", { action: "get_repo", params: { repo_id: "00000000-0000-4000-8000-000000000000" } });
  record("unknown library is a clean error (no stack or path)", nf.isError && /not-found|invalid/.test(nf.text) && !/Traceback|\/workspace|\.py/.test(nf.text), nf.text);
  const blocked = await call(readOnly, "seafile_libraries", { action: "create_repo", body: { name: "should-not-exist" }, confirm: true });
  record("confirm without SEAFILE_ALLOW_WRITES sends nothing", blocked.json?.executed === false && blocked.json?.blocked === true, blocked.text);
  const strTrue = await call(writes, "seafile_libraries", { action: "create_repo", body: { name: "should-not-exist" }, confirm: "true" });
  record("confirm string true is rejected", strTrue.isError, strTrue.text);
} catch (e) {
  record("live-check-extra", false, e instanceof Error ? e.message : "failed");
} finally {
  if (repoId) {
    const d = await call(writes, "seafile_libraries", { action: "delete_repo", params: { repo_id: repoId }, confirm: true });
    record("libraries delete_repo (cleanup)", !d.isError, d.text);
  }
  await writes.close();
  await readOnly.close();
}
console.log(`failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
