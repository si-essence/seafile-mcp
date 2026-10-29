import { z } from "zod";
import { brandBaseUrl, brandSecret, type BaseUrl, type Secret } from "./brand.js";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "./constants.js";
import { ConnectorError } from "./errors.js";
import { parseToolsets } from "./operations.js";
import { fixedError } from "./zod-messages.js";

const invalid = fixedError("invalid");

const EnvSchema = z.object({
  SEAFILE_TOKEN: z
    .string({ error: invalid })
    .trim()
    .min(8, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
  SEAFILE_URL: z.url({ error: invalid }),
  SEAFILE_FILE_SERVER_URL: z.url({ error: invalid }).optional(),
  SEAFILE_ALLOW_WRITES: z.string({ error: invalid }).optional(),
  SEAFILE_TOOLSETS: z.string({ error: invalid }).optional(),
  SEAFILE_REVEAL_LINK_TOKENS: z.string({ error: invalid }).optional(),
  SEAFILE_PER_MINUTE: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  SEAFILE_TIMEOUT_MS: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  SEAFILE_CONTACT: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(120, { error: invalid })
    .optional(),
  MCP_TRANSPORT: z.enum(["stdio", "http"], { error: invalid }).optional(),
  PORT: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  SEAFILE_CACHE_TTL_SEC: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
});

export interface Config {
  token: Secret | undefined;
  baseUrl: BaseUrl;
  fileServerUrl: BaseUrl | undefined;
  allowWrites: boolean;
  revealLinkTokens: boolean;
  toolsets: readonly string[];
  perMinute: number;
  timeoutMs: number;
  contact: string;
  transport: "stdio" | "http";
  port: number;
  cacheTtlSec: number;
  userAgent: string;
}

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return blank(env[name]);
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path =
        issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join(".");
      return `${path} (${issue.code})`;
    })
    .join("; ");
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (raw === undefined) return fallback;
  const parsed = z.number().int().min(min).max(max).safeParse(Number(raw));
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${field} (out_of_range).`);
  }
  return parsed.data;
}

function userAgentFor(contact: string): string {
  const clean = contact
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 120);
  return `${CONNECTOR_NAME}/${CONNECTOR_VERSION} (${clean.length > 0 ? clean : "contact@example.com"})`;
}

export function isSeafileHostedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "seafile.com" || host.endsWith(".seafile.com");
}

function parseHttpUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError("config", `Invalid environment: ${field} (invalid_url).`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorError("config", `Invalid environment: ${field} (invalid_url).`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConnectorError("config", `Invalid environment: ${field} (userinfo).`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConnectorError("config", `Invalid environment: ${field} (query_or_hash).`);
  }
  if (isSeafileHostedHost(url.hostname)) {
    throw new ConnectorError(
      "config",
      `Invalid environment: ${field} (hosted_seafile). This connector talks only to a server you host. seafile.com hosts are refused.`,
    );
  }
  return url;
}

function normalizeOrigin(value: string, field: string): BaseUrl {
  const url = parseHttpUrl(value, field);
  let href = value.replace(/\/+$/, "");
  if (url.pathname !== "/" && url.pathname !== "") {
    href = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } else {
    href = url.origin;
  }
  return brandBaseUrl(href);
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
  const urlRaw = read(env, "SEAFILE_URL");
  if (urlRaw === undefined) {
    throw new ConnectorError(
      "config",
      "Invalid environment: SEAFILE_URL (required). Set it to your self-hosted Seafile origin, for example http://127.0.0.1:8000.",
    );
  }

  const parsed = EnvSchema.safeParse({
    SEAFILE_TOKEN: read(env, "SEAFILE_TOKEN"),
    SEAFILE_URL: urlRaw,
    SEAFILE_FILE_SERVER_URL: read(env, "SEAFILE_FILE_SERVER_URL"),
    SEAFILE_ALLOW_WRITES: read(env, "SEAFILE_ALLOW_WRITES"),
    SEAFILE_TOOLSETS: read(env, "SEAFILE_TOOLSETS"),
    SEAFILE_REVEAL_LINK_TOKENS: read(env, "SEAFILE_REVEAL_LINK_TOKENS"),
    SEAFILE_PER_MINUTE: read(env, "SEAFILE_PER_MINUTE"),
    SEAFILE_TIMEOUT_MS: read(env, "SEAFILE_TIMEOUT_MS"),
    SEAFILE_CONTACT: read(env, "SEAFILE_CONTACT"),
    MCP_TRANSPORT: read(env, "MCP_TRANSPORT"),
    PORT: read(env, "PORT"),
    SEAFILE_CACHE_TTL_SEC: read(env, "SEAFILE_CACHE_TTL_SEC"),
  });
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${issueSummary(parsed.error)}.`);
  }

  const data = parsed.data;
  const token = data.SEAFILE_TOKEN === undefined ? undefined : brandSecret(data.SEAFILE_TOKEN);
  const baseUrl = normalizeOrigin(data.SEAFILE_URL, "SEAFILE_URL");
  const fileServerUrl =
    data.SEAFILE_FILE_SERVER_URL === undefined
      ? undefined
      : normalizeOrigin(data.SEAFILE_FILE_SERVER_URL, "SEAFILE_FILE_SERVER_URL");
  const contact = data.SEAFILE_CONTACT ?? "contact@example.com";
  if (hasControlChar(contact)) {
    throw new ConnectorError("config", "Invalid environment: SEAFILE_CONTACT (control_character).");
  }
  const userAgent = userAgentFor(contact);
  if (token !== undefined && baseUrl.includes(token)) {
    throw new ConnectorError("config", "Invalid environment: SEAFILE_URL (contains_secret).");
  }
  if (token !== undefined && (contact.includes(token) || userAgent.includes(token))) {
    throw new ConnectorError("config", "Invalid environment: SEAFILE_CONTACT (contains_secret).");
  }
  if (token !== undefined && fileServerUrl !== undefined && fileServerUrl.includes(token)) {
    throw new ConnectorError(
      "config",
      "Invalid environment: SEAFILE_FILE_SERVER_URL (contains_secret).",
    );
  }

  const envTransport = data.MCP_TRANSPORT ?? "stdio";
  const transport = argv.includes("--http") ? "http" : envTransport;
  const allowWrites = data.SEAFILE_ALLOW_WRITES === "true";
  let toolsets: readonly string[];
  try {
    toolsets = parseToolsets(data.SEAFILE_TOOLSETS);
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("config", "Invalid environment: SEAFILE_TOOLSETS.");
  }

  return {
    token,
    baseUrl,
    fileServerUrl,
    allowWrites,
    revealLinkTokens: data.SEAFILE_REVEAL_LINK_TOKENS === "true",
    toolsets,
    perMinute: boundedInt(data.SEAFILE_PER_MINUTE, 30, 1, 10_000, "SEAFILE_PER_MINUTE"),
    timeoutMs: boundedInt(data.SEAFILE_TIMEOUT_MS, 20_000, 100, 120_000, "SEAFILE_TIMEOUT_MS"),
    contact,
    transport,
    port: boundedInt(data.PORT, 3000, 1, 65_535, "PORT"),
    cacheTtlSec: boundedInt(data.SEAFILE_CACHE_TTL_SEC, 60, 0, 86_400, "SEAFILE_CACHE_TTL_SEC"),
    userAgent,
  };
}
