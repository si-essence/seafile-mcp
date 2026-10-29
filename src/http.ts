import type { BaseUrl, Secret } from "./brand.js";
import { TtlCache } from "./cache.js";
import { ConnectorError } from "./errors.js";
import type { Logger } from "./log.js";
import { publicErrorText, toResult } from "./parse.js";
import type { RateLimiter } from "./rate-limit.js";
import { redact, redactUnknown, stripUrls } from "./redact.js";

export const API_KEY_HEADER = "authorization";
const MAX_BODY = 1_000_000;

export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];
export type QueryMap = Readonly<Record<string, QueryValue>>;

export interface ExchangeRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query: QueryMap | undefined;
  body: unknown;
  encoding: "json" | "form";
  ttlSec: number;
}

export interface AbsoluteRequest {
  url: URL;
  method: "GET" | "POST";
  body?: string | undefined;
  contentType?: string | undefined;
  maxBytes: number;
  auth: boolean;
  allow: (url: URL) => void;
}

export interface HttpClientOptions {
  baseUrl: BaseUrl;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  secrets: readonly string[];
  cache: TtlCache;
  limiter: RateLimiter;
  userAgent: string;
  logger: Logger;
  token: Secret | undefined;
  label: string;
}

type Method = ExchangeRequest["method"];

export class HttpClient {
  private readonly baseUrl: BaseUrl;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly secrets: readonly string[];
  private readonly cache: TtlCache;
  private readonly limiter: RateLimiter;
  private readonly userAgent: string;
  private readonly logger: Logger;
  private readonly token: Secret | undefined;
  private readonly label: string;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
    this.secrets = options.secrets;
    this.cache = options.cache;
    this.limiter = options.limiter;
    this.userAgent = options.userAgent;
    this.logger = options.logger;
    this.token = options.token;
    this.label = options.label;
  }

  async exchange(request: ExchangeRequest): Promise<Record<string, unknown>> {
    const url = this.buildUrl(request.path, request.query);
    const cacheKey = `${request.method} ${url.origin}${url.pathname}${url.search}`;
    if (request.method === "GET" && request.ttlSec > 0) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined && cached !== null && typeof cached === "object") {
        return toResult(cached);
      }
      if (cached !== undefined) this.cache.delete(cacheKey);
    }
    const bodyText =
      request.method === "GET" ? undefined : this.serialize(request.body, request.encoding);
    const contentType =
      bodyText === undefined
        ? undefined
        : request.encoding === "form"
          ? "application/x-www-form-urlencoded"
          : "application/json";
    const response = await this.dispatch(
      url,
      request.method,
      bodyText,
      "application/json, text/plain",
      {
        auth: true,
        ...(contentType === undefined ? {} : { contentType }),
      },
    );
    const text = await readLimited(response, this.label, MAX_BODY);
    if (response.status >= 300 && response.status < 400) {
      const record = text.trim().length === 0 ? { ok: true } : toResult(parseBody(text));
      const location = response.headers.get("location");
      if (location !== null && location.length > 0) record["location"] = location;
      record["status"] = response.status;
      this.cache.clear();
      return record;
    }
    if (!response.ok) throw this.httpError(response, text);
    this.rejectHtml(text, response.status);
    const record = toResult(parseBody(text));
    if (request.method === "GET" && request.ttlSec > 0) {
      this.cache.set(cacheKey, redactUnknown(record, this.secrets), request.ttlSec);
    } else if (request.method !== "GET") {
      this.cache.clear();
    }
    return record;
  }

  async exchangeAbsolute(
    request: AbsoluteRequest,
  ): Promise<{ status: number; text: string; contentType: string }> {
    request.allow(request.url);
    let response = await this.dispatch(request.url, request.method, request.body, "*/*", {
      auth: request.auth,
      ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (location === null || location.length === 0) {
        throw new ConnectorError("server", `${this.label} redirect had no location.`);
      }
      let next: URL;
      try {
        next = new URL(location, request.url);
      } catch {
        throw new ConnectorError("input", "File server redirect URL was not valid.");
      }
      request.allow(next);
      response = await this.dispatch(next, "GET", undefined, "*/*", { auth: false });
    }
    const text = await readLimited(response, this.label, request.maxBytes);
    if (!response.ok) throw this.httpError(response, text);
    return {
      status: response.status,
      text,
      contentType: response.headers.get("content-type") ?? "",
    };
  }

  private serialize(body: unknown, encoding: "json" | "form"): string | undefined {
    if (body === undefined) return undefined;
    const text = encoding === "form" ? serializeForm(body) : serializeJson(body);
    if (text.length > MAX_BODY) {
      throw new ConnectorError("input", "Request body was too large.");
    }
    this.assertNoSecret(text, "Refusing to place a secret in the request.");
    return text;
  }

  private buildUrl(path: string, query: QueryMap | undefined): URL {
    if (
      path.length === 0 ||
      path.startsWith("//") ||
      path.includes("?") ||
      path.includes("#") ||
      path.includes("\\") ||
      path.split("/").includes("..")
    ) {
      throw new ConnectorError("input", "Request path must stay on the configured base URL.");
    }
    this.assertNoSecret(path, "Refusing to place a secret in the request URL.");
    const base = new URL(`${this.baseUrl}/`);
    const relative = path.startsWith("/") ? path.slice(1) : path;
    const url = new URL(relative, base);
    if (url.origin !== base.origin) {
      throw new ConnectorError("input", "Request path must stay on the configured base URL.");
    }
    if (query !== undefined) {
      for (const key of Object.keys(query).sort()) {
        const value = query[key];
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            const text = String(item);
            this.assertNoSecret(text, "Refusing to place a secret in the request URL.");
            url.searchParams.append(key, text);
          }
        } else {
          const text = String(value);
          this.assertNoSecret(text, "Refusing to place a secret in the request URL.");
          url.searchParams.set(key, text);
        }
      }
    }
    return url;
  }

  private assertNoSecret(value: string, message: string): void {
    for (const secret of this.secrets) {
      if (
        secret.length >= 8 &&
        (value.includes(secret) || value.includes(encodeURIComponent(secret)))
      ) {
        this.logger.error(message);
        throw new ConnectorError("config", message);
      }
    }
  }

  private requireToken(auth: boolean): void {
    if (auth && this.token === undefined) {
      throw new ConnectorError(
        "config",
        "SEAFILE_TOKEN is not set. Add an account or library API token before calling the upstream API.",
      );
    }
  }

  private async dispatch(
    url: URL,
    method: Method,
    body: string | undefined,
    accept: string,
    options: { auth: boolean; contentType?: string },
  ): Promise<Response> {
    this.requireToken(options.auth);
    this.limiter.acquire();
    const headers = new Headers();
    headers.set("accept", accept);
    headers.set("user-agent", this.userAgent);
    if (options.auth && this.token !== undefined) {
      headers.set(API_KEY_HEADER, `Token ${this.token}`);
    }
    if (options.contentType !== undefined) headers.set("content-type", options.contentType);
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        const seconds = Math.max(1, Math.round(this.timeoutMs / 1000));
        throw new ConnectorError("timeout", `${this.label} request timed out after ${seconds}s.`);
      }
      const raw = error instanceof Error ? error.message : "network error";
      const safe = stripUrls(redact(raw, this.secrets)).replace(/\s+/g, " ").trim().slice(0, 180);
      this.logger.error(`${this.label} request failed: ${safe}`);
      throw new ConnectorError("network", `${this.label} request failed: ${safe}`);
    }
  }

  private rejectHtml(text: string, status: number): void {
    if (/<!doctype html|<html[\s>]/i.test(text)) {
      throw new ConnectorError(
        "server",
        `${this.label} HTTP ${status}: the service returned an error page instead of JSON.`,
      );
    }
  }

  private httpError(response: Response, text: string): ConnectorError {
    const snippet = publicErrorText(text, this.secrets);
    const detail = snippet.length > 0 ? `: ${snippet}` : "";
    const status = response.status;
    if (status === 401) {
      return new ConnectorError(
        "unauthorized",
        `${this.label} HTTP 401: the token was rejected${detail}`,
      );
    }
    if (status === 403) {
      return new ConnectorError(
        "forbidden",
        `${this.label} HTTP 403: the token cannot perform that action${detail}`,
      );
    }
    if (status === 400 || status === 422) {
      return new ConnectorError("invalid", `${this.label} HTTP ${status}${detail}`);
    }
    if (status === 404) {
      return new ConnectorError("not_found", `${this.label} HTTP 404${detail}`);
    }
    if (status === 429) {
      const retry = retryAfterSeconds(response);
      const retryNote = retry === null ? "" : ` Retry after ${retry}s.`;
      return new ConnectorError(
        "rate_limit",
        `${this.label} HTTP 429${detail}.${retryNote}`.replace("..", "."),
        retry,
      );
    }
    this.logger.error(`${this.label} HTTP ${status}${detail}`);
    if (status >= 500) {
      return new ConnectorError("server", `${this.label} HTTP ${status}${detail}`);
    }
    return new ConnectorError("server", `${this.label} HTTP ${status}${detail}`);
  }
}

function serializeJson(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch {
    throw new ConnectorError("input", "Request body could not be serialized as JSON.");
  }
}

function serializeForm(body: unknown): string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ConnectorError("input", "Form body must be an object.");
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      params.append(key, String(value));
      continue;
    }
    params.append(key, JSON.stringify(value));
  }
  return params.toString();
}

function parseBody(text: string): unknown {
  if (text.trim().length === 0) return { ok: true };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { value: text.slice(0, 100_000) };
  }
}

async function readLimited(response: Response, label: string, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("server", `${label} response was too large to parse.`);
  }
  let text = "";
  try {
    text = await response.text();
  } catch {
    throw new ConnectorError("network", `${label} response could not be read.`);
  }
  if (text.length > maxBytes) {
    throw new ConnectorError("server", `${label} response was too large to parse.`);
  }
  return text;
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  if (/^[0-9]+$/.test(raw)) {
    const seconds = Number(raw);
    return seconds > 0 ? seconds : null;
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(1, Math.ceil((when - Date.now()) / 1000));
}
