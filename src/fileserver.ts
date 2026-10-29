import type { BaseUrl } from "./brand.js";
import { isSeafileHostedHost } from "./config.js";
import { ConnectorError } from "./errors.js";

export function assertAllowedFileUrl(
  target: URL,
  baseUrl: BaseUrl,
  fileServerUrl: BaseUrl | undefined,
): void {
  if (target.username !== "" || target.password !== "") {
    throw new ConnectorError("input", "File server URL must not include userinfo.");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new ConnectorError("input", "File server URL must be http or https.");
  }
  if (isSeafileHostedHost(target.hostname)) {
    throw new ConnectorError("input", "File server host is a hosted Seafile domain.");
  }
  const base = new URL(baseUrl);
  const sameOrigin = target.origin === base.origin;
  const seafhttp = target.hostname === base.hostname && target.pathname.startsWith("/seafhttp");
  const configured = fileServerUrl !== undefined && target.origin === new URL(fileServerUrl).origin;
  if (!sameOrigin && !seafhttp && !configured) {
    throw new ConnectorError(
      "input",
      "File server URL host is not SEAFILE_URL or SEAFILE_FILE_SERVER_URL.",
    );
  }
}

export function resolveFileUrl(raw: string, baseUrl: BaseUrl): URL {
  const trimmed = raw.trim().replace(/^"|"$/g, "");
  try {
    if (trimmed.startsWith("/")) return new URL(trimmed, `${baseUrl}/`);
    return new URL(trimmed);
  } catch {
    throw new ConnectorError("server", "Seafile did not return a file server URL.");
  }
}

export function libraryPath(value: string): string {
  if (!value.startsWith("/")) {
    throw new ConnectorError("input", "Library path must start with /.");
  }
  if (value.includes("\0") || value.includes("\\") || value.includes("://")) {
    throw new ConnectorError("input", "Library path is not valid.");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || part === ".")) {
    throw new ConnectorError("input", "Library path must stay inside the library.");
  }
  return value;
}
