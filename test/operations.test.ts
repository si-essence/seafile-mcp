import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALL_TOOLSETS,
  DEFAULT_TOOLSETS,
  OPERATIONS,
  parseToolsets,
  routeKeys,
  toolNames,
  toolsForToolsets,
} from "../src/operations.js";

describe("route table coverage", () => {
  it("matches seafile.routes.json in both directions", () => {
    const spec = JSON.parse(readFileSync(new URL("../seafile.routes.json", import.meta.url), "utf8")) as {
      operations: { method: string; path: string }[];
    };
    const specKeys = spec.operations.map((row) => `${row.method} ${row.path}`).sort();
    expect(routeKeys()).toEqual(specKeys);
    expect(OPERATIONS).toHaveLength(spec.operations.length);
    expect(OPERATIONS).toHaveLength(655);
    expect(toolNames()).toHaveLength(ALL_TOOLSETS.length);
    expect(DEFAULT_TOOLSETS).toEqual(["server", "libraries", "files_and_dirs", "search"]);
    const actions = OPERATIONS.map((row) => `${row.tool}::${row.action}`);
    expect(new Set(actions).size).toBe(actions.length);
    expect(ALL_TOOLSETS.length).toBeGreaterThanOrEqual(20);
    expect(ALL_TOOLSETS.length).toBeLessThanOrEqual(30);
  });

  it("gates every non-GET and side-effect download or upload link", () => {
    const reads = OPERATIONS.filter((row) => row.method === "GET" && !row.write);
    expect(reads.every((row) => !row.path.endsWith("/file/"))).toBe(true);
    const download = OPERATIONS.find(
      (row) => row.method === "GET" && row.path === "/api2/repos/{repo_id}/file/",
    );
    expect(download?.write).toBe(true);
    expect(download?.warnings.length).toBeGreaterThan(0);
    const upload = OPERATIONS.find(
      (row) => row.method === "GET" && row.path === "/api2/repos/{repo_id}/upload-link/",
    );
    expect(upload?.write).toBe(true);
    const auth = OPERATIONS.find((row) => row.method === "POST" && row.path === "/api2/auth-token/");
    expect(auth?.write).toBe(true);
    expect(auth?.warnings.join(" ")).toContain("token");
  });
});

describe("toolset scoping", () => {
  it("defaults to the read-focused subset and treats all as every toolset", () => {
    expect(parseToolsets(undefined)).toEqual([...DEFAULT_TOOLSETS]);
    expect(parseToolsets("all")).toEqual([...ALL_TOOLSETS]);
    expect(toolsForToolsets(parseToolsets(undefined))).toEqual([
      "seafile_files_and_dirs",
      "seafile_libraries",
      "seafile_search",
      "seafile_server",
    ]);
    expect(toolsForToolsets(parseToolsets("all"))).toEqual(toolNames());
    expect(parseToolsets("admin_users")).toEqual(["admin_users"]);
    expect(DEFAULT_TOOLSETS.some((name) => name.startsWith("admin"))).toBe(false);
  });
});
