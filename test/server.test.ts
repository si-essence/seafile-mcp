import { describe, expect, it } from "vitest";
import { jsonFetch, jsonResponse, runtimeFor } from "./harness.js";
import { connectServer } from "./mcp.js";

describe("server", () => {
  it("publishes the default toolsets and hides admin", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({ ok: true }));
    const runtime = runtimeFor(fetchImpl, { SEAFILE_TOOLSETS: undefined });
    const { client, close } = await connectServer(runtime);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "seafile_files_and_dirs",
        "seafile_libraries",
        "seafile_search",
        "seafile_server",
      ]);
    } finally {
      await close();
    }
  });
});
