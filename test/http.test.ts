import { describe, expect, it } from "vitest";
import { ConnectorError } from "../src/errors.js";
import { BASE, expectAuth, jsonFetch, jsonResponse, runtimeFor } from "./harness.js";

describe("http client", () => {
  it("sends Authorization Token and does not follow a redirect", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      expectAuth(captured);
      return new Response("success", {
        status: 301,
        headers: { location: "https://evil.example/steal", "content-type": "text/plain" },
      });
    });
    const runtime = runtimeFor(fetchImpl);
    const result = await runtime.client.exchange({
      method: "POST",
      path: "/api2/repos/repo-sample/dir/",
      query: { p: "/notes" },
      body: { operation: "mkdir" },
      encoding: "form",
      ttlSec: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.contentType).toContain("application/x-www-form-urlencoded");
    expect(String(calls[0]?.body)).toContain("operation=mkdir");
    expect(result["location"]).toBe("https://evil.example/steal");
    expect(result["status"]).toBe(301);
  });

  it("uses JSON for v2.1 bodies", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ ok: true }));
    const runtime = runtimeFor(fetchImpl);
    await runtime.client.exchange({
      method: "POST",
      path: "/api/v2.1/share-links/",
      query: undefined,
      body: { repo_id: "repo-sample", path: "/a.txt" },
      encoding: "json",
      ttlSec: 0,
    });
    expect(calls[0]?.contentType).toContain("application/json");
    expect(calls[0]?.url).toBe(`${BASE}/api/v2.1/share-links/`);
  });

  it("requires a token", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({ ok: true }));
    const runtime = runtimeFor(fetchImpl, { SEAFILE_TOKEN: undefined });
    await expect(
      runtime.client.exchange({
        method: "GET",
        path: "/api2/ping/",
        query: undefined,
        body: undefined,
        encoding: "json",
        ttlSec: 0,
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it("maps a timeout", async () => {
    const fetchImpl: typeof fetch = () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      return Promise.reject(error);
    };
    const runtime = runtimeFor(fetchImpl, { SEAFILE_TIMEOUT_MS: "1000" });
    await expect(
      runtime.client.exchange({
        method: "GET",
        path: "/api2/ping/",
        query: undefined,
        body: undefined,
        encoding: "json",
        ttlSec: 0,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});
