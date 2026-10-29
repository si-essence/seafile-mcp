import { ConnectorError } from "./errors.js";
import type { QueryMap, QueryValue } from "./http.js";

export function definedQuery(
  record: Readonly<Record<string, QueryValue | undefined>>,
): QueryMap | undefined {
  const out: Record<string, QueryValue> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function fillRoutePath(
  routePath: string,
  params: Readonly<Record<string, string | number>>,
): string {
  if (!routePath.startsWith("/")) {
    throw new ConnectorError("input", "Route path must start with /.");
  }
  const filled = routePath.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") {
      throw new ConnectorError("input", `Missing path parameter ${name}.`);
    }
    return encodeURIComponent(String(value));
  });
  if (filled.includes("{") || filled.includes("}")) {
    throw new ConnectorError("input", "Request path still contains a template marker.");
  }
  return filled;
}
