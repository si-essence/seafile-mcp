import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideWrite } from "../src/write-gate.js";
import { OPERATIONS, toolIsWrite, toolNames, type Operation } from "../src/operations.js";
import { BASE, TOKEN, expectAuth, jsonFetch, jsonResponse, runtimeFor, textResponse } from "./harness.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const TOOL_NAMES = toolNames();
const WRITE_OPS = OPERATIONS.filter((operation) => operation.write);
const READ_OPS = OPERATIONS.filter((operation) => !operation.write);

function argsFor(operation: Operation): Record<string, unknown> {
  const args: Record<string, unknown> = { action: operation.action };
  if (Object.keys(operation.sampleParams).length > 0) args["params"] = operation.sampleParams;
  if (operation.method !== "GET") args["body"] = { name: "sample" };
  return args;
}

async function withClient(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const runtime = runtimeFor(fetchImpl, extra);
  const connected = await connectServer(runtime);
  try {
    await run(connected.client);
  } finally {
    await connected.close();
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; json: Record<string, unknown> | null }> {
  const result = readToolText(await client.callTool({ name, arguments: args }));
  expect(result.text).not.toContain(TOKEN);
  if (result.isError) return { ...result, json: null };
  return { ...result, json: JSON.parse(result.text) as Record<string, unknown> };
}

describe("seafile tools", () => {
  it("publishes every tool with a description and confirm on writes", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({ ok: true }));
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(TOOL_NAMES);
      for (const tool of listed.tools) {
        expect((tool.description ?? "").trim().length).toBeGreaterThan(20);
        const schema = JSON.stringify(tool.inputSchema);
        if (toolIsWrite(tool.name) || tool.name === "seafile_files_and_dirs") {
          expect(schema).toContain("confirm");
        }
        if (!toolIsWrite(tool.name) && tool.name !== "seafile_files_and_dirs") {
          expect(schema).not.toContain("confirm");
        }
      }
      const files = listed.tools.find((tool) => tool.name === "seafile_files_and_dirs");
      const described = files?.description ?? "";
      expect(described).toContain("read_text_file");
      expect(described).toContain("write_text_file");
      expect(described).toContain("library id and path");
    });
  });

  it("scopes the published set to SEAFILE_TOOLSETS", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({ ok: true }));
    await withClient(fetchImpl, { SEAFILE_TOOLSETS: "server,search" }, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "seafile_search",
        "seafile_server",
      ]);
    });
    await withClient(fetchImpl, { SEAFILE_TOOLSETS: undefined }, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "seafile_files_and_dirs",
        "seafile_libraries",
        "seafile_search",
        "seafile_server",
      ]);
      expect(listed.tools.some((tool) => tool.name.startsWith("seafile_admin"))).toBe(false);
    });
  });

  it("redacts tokens, share links, and drops stack traces", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      expectAuth(captured);
      return jsonResponse({
        repo_id: "repo-keep",
        token: "share-link-secret-token",
        password: "hunter2-secret-value",
        link: "https://seafile.test/f/share-link-secret-token/",
        stack: "Error\n    at /usr/src/app/server.ts:9:1",
        note: `hello ${TOKEN}`,
      });
    });
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await call(client, "seafile_server", { action: "ping" });
      expect(listed.isError).toBe(false);
      const raw = JSON.stringify(listed.json);
      expect(raw).toContain("[redacted]");
      expect(raw).toContain("repo-keep");
      expect(raw).not.toContain("share-link-secret-token");
      expect(raw).not.toContain("hunter2-secret-value");
      expect(raw).not.toContain("/usr/src");
      expect(raw).not.toContain("stack");
      expect(raw).not.toContain(TOKEN);
      expect(calls[0]?.url).toBe(`${BASE}/api2/ping/`);
      expect(calls[0]?.authorization).toBe(`Token ${TOKEN}`);
    });
  });

  it("previews a delete with the library id and sends nothing", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ ok: true }));
    await withClient(fetchImpl, {}, async (client) => {
      const preview = await call(client, "seafile_libraries", {
        action: "delete_repo",
        params: { repo_id: "repo-sample" },
      });
      expect(preview.json).toMatchObject({
        executed: false,
        dry_run: true,
        blocked: false,
        method: "DELETE",
        path: "/api2/repos/repo-sample/",
      });
      expect(JSON.stringify(preview.json)).toContain("Target library repo-sample path");
      expect(calls).toHaveLength(0);
    });
  });

  it("blocks a confirmed write when SEAFILE_ALLOW_WRITES is not true", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ ok: true }));
    await withClient(fetchImpl, { SEAFILE_ALLOW_WRITES: "false" }, async (client) => {
      const result = await call(client, "seafile_libraries", {
        action: "delete_repo",
        params: { repo_id: "repo-sample" },
        confirm: true,
      });
      expect(result.json).toMatchObject({ executed: false, blocked: true, method: "DELETE" });
      expect(JSON.stringify(result.json)).toContain("SEAFILE_ALLOW_WRITES");
      expect(calls).toHaveLength(0);
    });
  });

  it("previews when writes are enabled and confirm is omitted", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ ok: true }));
    await withClient(fetchImpl, { SEAFILE_ALLOW_WRITES: "true" }, async (client) => {
      const result = await call(client, "seafile_libraries", {
        action: "create_repo",
        body: { name: "Lab", passwd: "library-secret-value" },
      });
      expect(result.json).toMatchObject({ executed: false, blocked: false, method: "POST" });
      expect(JSON.stringify(result.json)).toContain("[redacted]");
      expect(JSON.stringify(result.json)).not.toContain("library-secret-value");
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects confirm false and the string true", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({ ok: true }));
    await withClient(fetchImpl, {}, async (client) => {
      const asFalse = await call(client, "seafile_libraries", {
        action: "delete_repo",
        params: { repo_id: "repo-sample" },
        confirm: false,
      });
      expect(asFalse.isError).toBe(true);
      const asString = await call(client, "seafile_libraries", {
        action: "delete_repo",
        params: { repo_id: "repo-sample" },
        confirm: "true",
      });
      expect(asString.isError).toBe(true);
    });
  });
});

describe("every registered tool", () => {
  it("has a coverage case for each published name", () => {
    const source = readFileSync(new URL("./seafile-tools.test.ts", import.meta.url), "utf8");
    expect(source).toContain("for (const operation of OPERATIONS)");
    expect(source).toContain("toolNames()");
    expect(source).toContain("read_text_file");
    expect(source).toContain("write_text_file");
    const covered = [...new Set(OPERATIONS.map((operation) => operation.tool))].sort();
    expect(covered).toEqual(TOOL_NAMES);
    for (const name of toolNames()) {
      expect(OPERATIONS.some((operation) => operation.tool === name)).toBe(true);
    }
  });

  it("previews every write, then confirms it, and reads every GET", async () => {
    const invoked = new Set<string>();
    const { fetchImpl, calls } = jsonFetch((captured) => {
      expectAuth(captured);
      return jsonResponse({ repo_id: "repo-keep", token: TOKEN, ok: true });
    });
    await withClient(fetchImpl, { SEAFILE_PER_MINUTE: "10000" }, async (client) => {
      for (const operation of OPERATIONS) {
        if (operation.write) {
          calls.length = 0;
          const preview = await call(client, operation.tool, argsFor(operation));
          expect(preview.isError, `${operation.tool} ${operation.action} preview`).toBe(false);
          expect(preview.json).toMatchObject({
            executed: false,
            dry_run: true,
            blocked: false,
            method: operation.method,
          });
          expect(calls).toHaveLength(0);
          const executed = await call(client, operation.tool, { ...argsFor(operation), confirm: true });
          expect(executed.isError, `${operation.tool} ${operation.action} confirm`).toBe(false);
          expect(executed.json).toMatchObject({ executed: true, dry_run: false });
          expect(executed.text).not.toContain(TOKEN);
          expect(calls[0]?.method).toBe(operation.method);
          expect(calls[0]?.authorization).toBe(`Token ${TOKEN}`);
        } else {
          calls.length = 0;
          const result = await call(client, operation.tool, argsFor(operation));
          expect(result.isError, `${operation.tool} ${operation.action}`).toBe(false);
          expect(result.text).not.toContain(TOKEN);
          expect(calls[0]?.method).toBe("GET");
          expect(calls[0]?.authorization).toBe(`Token ${TOKEN}`);
        }
        invoked.add(operation.tool);
      }
    });
    expect([...invoked].sort()).toEqual(TOOL_NAMES);
    expect(READ_OPS.length + WRITE_OPS.length).toBe(655);
  }, 180_000);
});

describe("text helpers", () => {
  it("previews read and write without calling upstream", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse("https://seafile.test/seafhttp/files/abcd1234wxyz/a.txt"));
    await withClient(fetchImpl, {}, async (client) => {
      const readPreview = await call(client, "seafile_files_and_dirs", {
        action: "read_text_file",
        params: { repo_id: "repo-sample" },
        query: { p: "/notes/a.txt" },
      });
      expect(readPreview.json).toMatchObject({ executed: false, dry_run: true, method: "GET" });
      expect(JSON.stringify(readPreview.json)).toContain("Target library repo-sample path /notes/a.txt");
      const writePreview = await call(client, "seafile_files_and_dirs", {
        action: "write_text_file",
        params: { repo_id: "repo-sample" },
        query: { p: "/notes/a.txt" },
        body: { text: "hello", replace: true },
      });
      expect(writePreview.json).toMatchObject({ executed: false, dry_run: true, method: "POST" });
      const raw = JSON.stringify(writePreview.json);
      expect(raw).toContain("Target library repo-sample path /notes/a.txt");
      expect(raw).toContain("overwrites");
      expect(calls).toHaveLength(0);
    });
  });

  it("reads text from the same host and refuses another host", async () => {
    const fileToken = "abcd1234wxyz";
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (captured.url.includes("/file/")) {
        expectAuth(captured);
        return jsonResponse(`https://seafile.test/seafhttp/files/${fileToken}/a.txt`);
      }
      expect(captured.authorization).toBeNull();
      return textResponse("hello from library");
    });
    await withClient(fetchImpl, {}, async (client) => {
      const read = await call(client, "seafile_files_and_dirs", {
        action: "read_text_file",
        params: { repo_id: "repo-sample" },
        query: { p: "/notes/a.txt" },
        confirm: true,
      });
      expect(read.isError).toBe(false);
      expect(read.json).toMatchObject({ executed: true });
      expect(JSON.stringify(read.json)).toContain("hello from library");
      expect(JSON.stringify(read.json)).not.toContain(fileToken);
      expect(calls).toHaveLength(2);
    });

    const evil = jsonFetch((captured) => {
      if (captured.url.includes("/file/")) {
        return jsonResponse("https://evil.example/files/abcd1234wxyz/a.txt");
      }
      return textResponse("nope");
    });
    await withClient(evil.fetchImpl, {}, async (client) => {
      const read = await call(client, "seafile_files_and_dirs", {
        action: "read_text_file",
        params: { repo_id: "repo-sample" },
        query: { p: "/notes/a.txt" },
        confirm: true,
      });
      expect(read.isError).toBe(true);
      expect(read.text).toContain("SEAFILE_URL");
      expect(read.text).not.toContain("evil.example");
      expect(evil.calls).toHaveLength(1);
    });
  });

  it("writes text on the configured file server and rejects binary downloads", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (captured.url.includes("/upload-link/")) {
        expectAuth(captured);
        return jsonResponse("https://files.seafile.test/upload-api/abcd1234wxyz");
      }
      expect(captured.authorization).toBeNull();
      expect(captured.method).toBe("POST");
      expect(String(captured.body)).toContain("hello file");
      expect(captured.url.startsWith("https://files.seafile.test/")).toBe(true);
      return jsonResponse(["file-id"]);
    });
    await withClient(
      fetchImpl,
      { SEAFILE_FILE_SERVER_URL: "https://files.seafile.test" },
      async (client) => {
        const wrote = await call(client, "seafile_files_and_dirs", {
          action: "write_text_file",
          params: { repo_id: "repo-sample" },
          query: { p: "/notes/a.txt" },
          body: { text: "hello file" },
          confirm: true,
        });
        expect(wrote.isError).toBe(false);
        expect(JSON.stringify(wrote.json)).toContain("Target library repo-sample path /notes/a.txt");
        expect(JSON.stringify(wrote.json)).not.toContain("abcd1234wxyz");
        expect(calls).toHaveLength(2);
        const replace = wrote.json?.["result"];
        expect(replace && typeof replace === "object" ? (replace as { replace?: boolean }).replace : true).toBe(
          false,
        );
      },
    );

    const binary = jsonFetch((captured) => {
      if (captured.url.includes("/file/")) {
        return jsonResponse("https://seafile.test/seafhttp/files/abcd1234wxyz/a.bin");
      }
      return textResponse("a\u0000b", 200, "application/octet-stream");
    });
    await withClient(binary.fetchImpl, {}, async (client) => {
      const read = await call(client, "seafile_files_and_dirs", {
        action: "read_text_file",
        params: { repo_id: "repo-sample" },
        query: { p: "/notes/a.bin" },
        confirm: true,
      });
      expect(read.isError).toBe(true);
      expect(read.text).toContain("not text");
    });
  });
});

describe("error paths", () => {
  it("maps 401, 403, 404, 422, 400, and 429 with Retry-After", async () => {
    const cases: { status: number; body: unknown; needle: string; retry?: string }[] = [
      { status: 401, body: { error_msg: `Unauthorized ${TOKEN}` }, needle: "401" },
      { status: 403, body: { error_msg: "Permission denied" }, needle: "403" },
      { status: 404, body: { error_msg: "Library not found" }, needle: "404" },
      { status: 422, body: { error_msg: "name invalid" }, needle: "422" },
      { status: 400, body: { error_msg: "Path is missing" }, needle: "400" },
      { status: 429, body: { error_msg: "Slow down" }, needle: "429", retry: "12" },
    ];
    for (const testCase of cases) {
      const { fetchImpl } = jsonFetch(
        () =>
          new Response(JSON.stringify(testCase.body), {
            status: testCase.status,
            headers: {
              "content-type": "application/json",
              ...(testCase.retry === undefined ? {} : { "retry-after": testCase.retry }),
            },
          }),
      );
      await withClient(fetchImpl, {}, async (client) => {
        const result = await call(client, "seafile_server", { action: "ping" });
        expect(result.isError).toBe(true);
        expect(result.text).toContain(testCase.needle);
        expect(result.text).not.toContain(TOKEN);
        expect(result.text).not.toContain("/tmp");
        if (testCase.status === 401) expect(result.text).toContain("[unauthorized]");
        if (testCase.status === 403) expect(result.text).toContain("[forbidden]");
        if (testCase.status === 404) expect(result.text).toContain("[not-found]");
        if (testCase.status === 400 || testCase.status === 422) expect(result.text).toContain("[invalid]");
        if (testCase.status === 429) {
          expect(result.text).toContain("[rate-limit]");
          expect(result.text).toContain("12");
        }
      });
    }
  });

  it("maps server and network failures without a stack", async () => {
    const server = jsonFetch(
      () =>
        new Response(
          JSON.stringify({
            error_msg: "Traceback (most recent call last):\n  File \"/var/lib/seafile/x.py\", line 1",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    );
    await withClient(server.fetchImpl, {}, async (client) => {
      const result = await call(client, "seafile_server", { action: "ping" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("[server]");
      expect(result.text).toContain("500");
      expect(result.text).not.toContain("/var/lib");
      expect(result.text).not.toContain("Traceback");
    });

    const network = jsonFetch(() => {
      throw new Error(`connect ECONNREFUSED ${TOKEN} /var/lib/seafile`);
    });
    await withClient(network.fetchImpl, {}, async (client) => {
      const result = await call(client, "seafile_server", { action: "ping" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("[network]");
      expect(result.text).not.toContain(TOKEN);
      expect(result.text).not.toContain("/var/lib");
    });
  });
});

describe("write gate", () => {
  it("requires both confirm true and the env flag", () => {
    const plan = {
      method: "DELETE" as const,
      path: "/api2/repos/repo-sample/",
      query: undefined,
      body: undefined,
      summary: "delete",
      warnings: ["Target library repo-sample path /."],
    };
    const noConfirm = decideWrite(true, undefined, plan, []);
    expect(noConfirm.kind).toBe("preview");
    const noEnv = decideWrite(false, true, plan, []);
    expect(noEnv.kind).toBe("preview");
    if (noEnv.kind === "preview") expect(noEnv.payload["blocked"]).toBe(true);
    expect(decideWrite(true, true, plan, []).kind).toBe("execute");
  });
});
