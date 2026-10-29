import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.js";
import { redact, redactUnknown, setRevealLinkTokens } from "../src/redact.js";
import { jsonFetch, jsonResponse, runtimeFor, TOKEN } from "./harness.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const KEY = TOKEN;
const ENCODED = encodeURIComponent(KEY);

function assertNoKey(label: string, text: string): void {
  expect(text, label).not.toContain(KEY);
  expect(text, label).not.toContain(ENCODED);
}

describe("redact", () => {
  it("strips the secret, its url encoding, query params, bearer tokens, and share tokens", () => {
    const raw = [
      `key=${KEY}`,
      `encoded=${ENCODED}`,
      `https://upstream.test/lookup?api_key=${KEY}&x=1`,
      `Authorization: Bearer ${KEY}`,
      `Authorization: Token ${KEY}`,
      "https://seafile.test/f/abcdefghijklmnop/",
      "https://seafile.test/seafhttp/upload-api/abcdefghijklmnop",
    ].join("\n");
    const cleaned = redact(raw, [KEY]);
    assertNoKey("redact", cleaned);
    expect(cleaned).toContain("api_key=[redacted]");
    expect(cleaned).toContain("Bearer [redacted]");
    expect(cleaned).toContain("Token [redacted]");
    expect(cleaned).not.toContain("abcdefghijklmnop");
    expect(cleaned).toContain("/f/[redacted]/");
  });

  it("redacts nested secret fields and keeps ids", () => {
    const cleaned = JSON.stringify(
      redactUnknown(
        {
          repo_id: "repo-keep",
          token: "share-link-secret-token",
          pwd_hash: "hash-value-secret",
          items: [{ title: `see ${KEY}` }],
        },
        [KEY],
      ),
    );
    assertNoKey("nested", cleaned);
    expect(cleaned).toContain("repo-keep");
    expect(cleaned).not.toContain("share-link-secret-token");
    expect(cleaned).not.toContain("hash-value-secret");
  });

  it("redacts logger lines", () => {
    const lines: string[] = [];
    const logger = createLogger([KEY], (line) => {
      lines.push(line);
    });
    logger.error(`upstream said ${KEY}`);
    assertNoKey("logger", lines.join("\n"));
    expect(lines.join("\n")).toContain("[redacted]");
  });

  it("keeps the token out of tool output", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({ id: "rec-1", title: `hello ${KEY}` }));
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({ name: "seafile_server", arguments: { action: "ping" } }),
      );
      assertNoKey("tool", result.text);
      expect(result.isError).toBe(false);
      expect(result.text).toContain("[redacted]");
    } finally {
      await close();
    }
    vi.restoreAllMocks();
  });
});

describe("link token reveal opt-in", () => {
  it("hides share link tokens by default and shows them only when enabled", () => {
    const value = {
      link: "https://seafile.test/f/abcdefghijklmnop/",
      token: "abcdefghijklmnop",
      password: "hunter22hunter",
    };
    try {
      setRevealLinkTokens(false);
      const hidden = JSON.stringify(redactUnknown(value, [KEY]));
      expect(hidden).not.toContain("abcdefghijklmnop");
      setRevealLinkTokens(true);
      const shown = JSON.stringify(redactUnknown(value, [KEY]));
      expect(shown).toContain("abcdefghijklmnop");
      expect(shown).not.toContain("hunter22hunter");
      expect(
        JSON.stringify(redactUnknown({ auth: `Authorization: Token ${KEY}` }, [KEY])),
      ).not.toContain(KEY);
    } finally {
      setRevealLinkTokens(false);
    }
  });
});
