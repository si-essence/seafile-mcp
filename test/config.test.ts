import { describe, expect, it } from "vitest";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "../src/constants.js";
import { isSeafileHostedHost, loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { DEFAULT_TOOLSETS } from "../src/operations.js";

const KEY = "super-secret/key+value=99";
const URL = "http://127.0.0.1:8000";

function messageOf(error: unknown): string {
  expect(error).toBeInstanceOf(ConnectorError);
  if (!(error instanceof ConnectorError)) throw error;
  return error.message;
}

function catchError(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return error;
  }
}

describe("loadConfig", () => {
  it("requires SEAFILE_URL", () => {
    const message = messageOf(catchError(() => loadConfig({}, [])));
    expect(message).toContain("SEAFILE_URL");
    expect(message).toContain("required");
  });

  it("applies defaults when the URL is set", () => {
    const config = loadConfig({ SEAFILE_URL: URL }, []);
    expect(config.token).toBeUndefined();
    expect(config.baseUrl).toBe(URL);
    expect(config.fileServerUrl).toBeUndefined();
    expect(config.allowWrites).toBe(false);
    expect(config.toolsets).toEqual([...DEFAULT_TOOLSETS]);
    expect(config.perMinute).toBe(30);
    expect(config.timeoutMs).toBe(20_000);
    expect(config.contact).toBe("contact@example.com");
    expect(config.transport).toBe("stdio");
    expect(config.port).toBe(3000);
    expect(config.cacheTtlSec).toBe(60);
    expect(config.userAgent).toBe(`${CONNECTOR_NAME}/${CONNECTOR_VERSION} (contact@example.com)`);
  });

  it("lets --http override the transport", () => {
    expect(
      loadConfig({ SEAFILE_URL: URL, MCP_TRANSPORT: "stdio" }, ["node", "app", "--http"]).transport,
    ).toBe("http");
    expect(loadConfig({ SEAFILE_URL: URL, MCP_TRANSPORT: "http" }, []).transport).toBe("http");
  });

  it("keeps a subpath and drops a trailing slash", () => {
    const config = loadConfig({ SEAFILE_URL: "http://127.0.0.1:8000/seafile/" }, []);
    expect(config.baseUrl).toBe("http://127.0.0.1:8000/seafile");
  });

  it("enables writes only when SEAFILE_ALLOW_WRITES is the literal true", () => {
    expect(loadConfig({ SEAFILE_URL: URL, SEAFILE_ALLOW_WRITES: "true" }, []).allowWrites).toBe(
      true,
    );
    expect(loadConfig({ SEAFILE_URL: URL, SEAFILE_ALLOW_WRITES: "yes" }, []).allowWrites).toBe(
      false,
    );
  });

  it("parses SEAFILE_TOOLSETS", () => {
    expect(loadConfig({ SEAFILE_URL: URL, SEAFILE_TOOLSETS: "server,search" }, []).toolsets).toEqual(
      ["server", "search"],
    );
    expect(loadConfig({ SEAFILE_URL: URL, SEAFILE_TOOLSETS: "all" }, []).toolsets).toContain(
      "admin_users",
    );
  });

  it("rejects an unknown toolset without echoing it", () => {
    const message = messageOf(
      catchError(() => loadConfig({ SEAFILE_URL: URL, SEAFILE_TOOLSETS: "nope" }, [])),
    );
    expect(message).toContain("SEAFILE_TOOLSETS");
    expect(message).not.toContain("nope");
  });

  it("rejects hosted seafile.com domains", () => {
    for (const host of [
      "https://seafile.com",
      "https://cloud.seafile.com",
      "https://files.seafile.com/foo",
    ]) {
      const message = messageOf(catchError(() => loadConfig({ SEAFILE_URL: host }, [])));
      expect(message).toContain("hosted_seafile");
      expect(message).not.toContain("cloud.seafile.com/");
    }
    expect(isSeafileHostedHost("seafile.example.com")).toBe(false);
    expect(loadConfig({ SEAFILE_URL: "https://seafile.example.com" }, []).baseUrl).toBe(
      "https://seafile.example.com",
    );
  });

  it("rejects a hosted file server and a file server that contains the token", () => {
    const hosted = messageOf(
      catchError(() =>
        loadConfig(
          { SEAFILE_URL: URL, SEAFILE_FILE_SERVER_URL: "https://download.seafile.com" },
          [],
        ),
      ),
    );
    expect(hosted).toContain("SEAFILE_FILE_SERVER_URL");
    expect(hosted).toContain("hosted_seafile");

    const leaked = messageOf(
      catchError(() =>
        loadConfig(
          {
            SEAFILE_URL: URL,
            SEAFILE_TOKEN: KEY,
            SEAFILE_FILE_SERVER_URL: `http://127.0.0.1:8082/${KEY}`,
          },
          [],
        ),
      ),
    );
    expect(leaked).toContain("contains_secret");
    expect(leaked).not.toContain(KEY);
  });

  it("reports invalid fields without the rejected value or the token", () => {
    const message = messageOf(
      catchError(() =>
        loadConfig({ SEAFILE_URL: URL, SEAFILE_TOKEN: KEY, PORT: "nope", MCP_TRANSPORT: "sse" }, []),
      ),
    );
    expect(message).toContain("PORT");
    expect(message).toContain("MCP_TRANSPORT");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("nope");
    expect(message).not.toContain("sse");
  });

  it("rejects a short token without echoing it", () => {
    const message = messageOf(
      catchError(() => loadConfig({ SEAFILE_URL: URL, SEAFILE_TOKEN: "short" }, [])),
    );
    expect(message).toContain("SEAFILE_TOKEN");
    expect(message).not.toContain("short");
  });

  it("rejects a base url or contact that contains the token", () => {
    const inUrl = messageOf(
      catchError(() =>
        loadConfig({ SEAFILE_TOKEN: KEY, SEAFILE_URL: `http://127.0.0.1:8000/${KEY}` }, []),
      ),
    );
    expect(inUrl).toContain("contains_secret");
    expect(inUrl).not.toContain(KEY);

    const inContact = messageOf(
      catchError(() => loadConfig({ SEAFILE_URL: URL, SEAFILE_TOKEN: KEY, SEAFILE_CONTACT: KEY }, [])),
    );
    expect(inContact).toContain("SEAFILE_CONTACT");
    expect(inContact).not.toContain(KEY);
  });

  it("rejects userinfo and query strings", () => {
    const userinfo = messageOf(
      catchError(() => loadConfig({ SEAFILE_URL: "http://user:pass@127.0.0.1:8000" }, [])),
    );
    expect(userinfo).toContain("userinfo");
    expect(userinfo).not.toContain("pass");
    const query = messageOf(
      catchError(() => loadConfig({ SEAFILE_URL: `http://127.0.0.1:8000/?token=${KEY}` }, [])),
    );
    expect(query).toContain("query_or_hash");
    expect(query).not.toContain(KEY);
  });
});
