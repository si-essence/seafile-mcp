import { ConnectorError } from "./errors.js";
import { definedQuery, fillRoutePath } from "./json.js";
import type { QueryMap } from "./http.js";
import type { Operation } from "./operations.js";
import type { Runtime } from "./runtime.js";
import { withWrite } from "./write-gate.js";

export interface CallArgs {
  readonly params?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly query?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly body?: unknown;
  readonly confirm?: true | undefined;
}

function asQuery(
  record: Readonly<Record<string, string | number | boolean>> | undefined,
): QueryMap | undefined {
  if (record === undefined) return undefined;
  const mapped: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(record)) mapped[key] = value;
  return definedQuery(mapped);
}

function asParams(
  record: Readonly<Record<string, string | number | boolean>> | undefined,
): Record<string, string | number> {
  if (record === undefined) return {};
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "boolean") out[key] = String(value);
    else out[key] = value;
  }
  return out;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function field(record: unknown, key: string): string | undefined {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  return scalar((record as Record<string, unknown>)[key]);
}

export function namesTarget(operation: Operation): boolean {
  const path = operation.path.toLowerCase();
  if (operation.destructive) return true;
  if (operation.method === "DELETE") return true;
  if (/revert|trash|move|copy/.test(path)) return true;
  if (/\/(file|dir)\/?$/.test(path) && operation.method !== "GET") return true;
  return false;
}

export function targetWarning(
  operation: Operation,
  params: Readonly<Record<string, string | number | boolean>> | undefined,
  query: Readonly<Record<string, string | number | boolean>> | undefined,
  body: unknown,
): string | undefined {
  if (!namesTarget(operation)) return undefined;
  const repo =
    field(params, "repo_id") ??
    field(body, "repo_id") ??
    field(params, "wiki_id") ??
    "(missing repo_id)";
  const path =
    field(query, "p") ??
    field(body, "p") ??
    field(body, "path") ??
    field(params, "path") ??
    "(missing path)";
  return `Target library ${repo} path ${path}.`;
}

function overwriteWarning(query: QueryMap | undefined, body: unknown): string | undefined {
  const queryReplace = query?.["replace"];
  const bodyReplace = field(body, "replace");
  const on =
    queryReplace === 1 ||
    queryReplace === true ||
    queryReplace === "1" ||
    queryReplace === "true" ||
    bodyReplace === "1" ||
    bodyReplace === "true";
  if (!on) return undefined;
  return "This can overwrite an existing file.";
}

export async function callSeafile(
  runtime: Runtime,
  operation: Operation,
  args: CallArgs = {},
): Promise<Record<string, unknown>> {
  const params = asParams(args.params);
  for (const name of operation.pathParams) {
    if (params[name] === undefined || params[name] === "") {
      throw new ConnectorError("input", `Missing path parameter ${name}.`);
    }
  }
  const path = fillRoutePath(operation.path, params);
  const query = asQuery(args.query);
  const warnings = [...operation.warnings];
  const target = targetWarning(operation, args.params, args.query, args.body);
  if (target !== undefined) warnings.push(target);
  const overwrite = overwriteWarning(query, args.body);
  if (overwrite !== undefined) warnings.push(overwrite);

  const run = async (): Promise<Record<string, unknown>> => {
    return runtime.client.exchange({
      method: operation.method,
      path,
      query,
      body: operation.method === "GET" ? undefined : args.body,
      encoding: operation.encoding,
      ttlSec: operation.write ? 0 : runtime.cacheTtlSec,
    });
  };

  if (!operation.write) return run();

  return withWrite(
    runtime,
    args.confirm,
    {
      method: operation.method,
      path,
      query,
      body: operation.method === "GET" ? undefined : args.body,
      summary: operation.summary,
      warnings,
    },
    run,
  );
}
