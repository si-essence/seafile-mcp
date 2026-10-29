import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolDescription, toolName } from "./brand.js";
import { callSeafile } from "./call.js";
import { CONNECTOR_NAME, CONNECTOR_TITLE, CONNECTOR_VERSION } from "./constants.js";
import { ConnectorError } from "./errors.js";
import { toolInputSchema, type ToolInput } from "./fields.js";
import { operationsForTool, toolsForToolsets, type Operation } from "./operations.js";
import type { Runtime } from "./runtime.js";
import { readTextFile, writeTextFile } from "./text-files.js";
import {
  READ_ONLY_REMOTE,
  WRITE_DESTRUCTIVE,
  WRITE_NON_IDEMPOTENT,
  registerConnectorTool,
  type ToolAnnotations,
  type ToolContext,
} from "./tools.js";

const FILES_TOOL = "seafile_files_and_dirs";
const FILE_HELPERS = ["read_text_file", "write_text_file"] as const;

export function createServer(runtime: Runtime): McpServer {
  const server = new McpServer({
    name: CONNECTOR_NAME,
    title: CONNECTOR_TITLE,
    version: CONNECTOR_VERSION,
  });
  const ctx: ToolContext = { secrets: runtime.secrets, logger: runtime.logger };
  for (const name of toolsForToolsets(runtime.config.toolsets)) {
    publishTool(server, ctx, runtime, name);
  }
  return server;
}

function publishTool(server: McpServer, ctx: ToolContext, runtime: Runtime, name: string): void {
  const operations = operationsForTool(name);
  const first = operations[0];
  if (first === undefined) return;
  const helpers = name === FILES_TOOL ? [...FILE_HELPERS] : [];
  const actions = [...operations.map((operation) => operation.action), ...helpers];
  const head = actions[0];
  if (head === undefined) return;
  const writes = helpers.length > 0 || operations.some((operation) => operation.write);
  const destructive = operations.some((operation) => operation.destructive);
  const annotations: ToolAnnotations = writes
    ? destructive
      ? WRITE_DESTRUCTIVE
      : WRITE_NON_IDEMPOTENT
    : READ_ONLY_REMOTE;
  const inputSchema = toolInputSchema([head, ...actions.slice(1)], writes);
  const description = describeTool(name, first.toolset, operations, writes, helpers);
  registerConnectorTool(
    server,
    {
      name: toolName(name),
      description: toolDescription(description),
      inputSchema,
      annotations,
      handler: (args) => handleTool(runtime, name, toInput({ ...args })),
    },
    ctx,
  );
}

async function handleTool(
  runtime: Runtime,
  tool: string,
  args: ToolInput,
): Promise<Record<string, unknown>> {
  if (tool === FILES_TOOL && args.action === "read_text_file") {
    return readTextFile(runtime, args);
  }
  if (tool === FILES_TOOL && args.action === "write_text_file") {
    return writeTextFile(runtime, args);
  }
  const operation = operationsForTool(tool).find((row) => row.action === args.action);
  if (operation === undefined) {
    throw new ConnectorError("input", `Unknown Seafile action ${args.action}.`);
  }
  return callSeafile(runtime, operation, {
    params: args.params,
    query: args.query,
    body: args.body,
    confirm: args.confirm,
  });
}

function toInput(args: Record<string, unknown>): ToolInput {
  const action = args["action"];
  if (typeof action !== "string") {
    throw new ConnectorError("input", "action is required.");
  }
  const confirm = args["confirm"];
  return {
    action,
    params: asStringMap(args["params"]),
    query: asStringMap(args["query"]),
    body: args["body"],
    confirm: confirm === true ? true : undefined,
  };
}

function asStringMap(
  value: unknown,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      out[key] = entry;
    }
  }
  return out;
}

function describeTool(
  name: string,
  toolset: string,
  operations: readonly Operation[],
  writes: boolean,
  helpers: readonly string[],
): string {
  const lines = operations.map((operation) => {
    const warning =
      operation.warnings.length > 0 ? " Warning: destructive, exposure, or credential change." : "";
    return `${operation.action}: ${operation.method} ${operation.path}. ${operation.summary}${warning}`;
  });
  if (helpers.includes("read_text_file")) {
    lines.push(
      "read_text_file: GET download link then fetch text. Query p is the library path. Params repo_id. Size cap 256 KiB. Text only. Gated. Warning: mints a download token.",
    );
    lines.push(
      "write_text_file: GET upload link then multipart POST. Query p is the library path. Body text string. Body replace defaults to false. Size cap 256 KiB. Gated. Warning: names the library id and path. replace true overwrites.",
    );
  }
  const gate = writes
    ? " Writes, including side-effect GETs, need confirm true and SEAFILE_ALLOW_WRITES=true. Omit confirm for a dry-run preview of method, path, and redacted body. Delete, purge, expire, revert, trash clean, move, copy, and overwrite previews name the library id and path."
    : "";
  return `${name} covers the ${toolset} toolset (${operations.length} route operations). Auth header Authorization Token. Self-hosted Seafile only. seafile.com hosts are refused.${gate} Actions: ${lines.join(" ")}`;
}
