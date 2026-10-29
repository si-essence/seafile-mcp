import { ConnectorError } from "./errors.js";
import { redact, stripUrls } from "./redact.js";

const MAX_DEPTH = 32;
const DROP_KEYS = new Set(["stack", "traceback", "stacktrace", "exc_info"]);

export function stripDanger(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === "string") return stripStackText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripDanger(item, depth + 1));
  }
  if (typeof value !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (DROP_KEYS.has(key.toLowerCase())) continue;
    out[key] = stripDanger(entry, depth + 1);
  }
  return out;
}

function stripStackText(text: string): string {
  if (/traceback \(most recent call last\)/i.test(text) || /\n\s+at \//.test(text)) {
    return "[omitted-error]";
  }
  return text;
}

export function stripPathsInText(text: string): string {
  return text
    .replace(/Traceback \(most recent call last\):[\s\S]*/gi, "")
    .replace(/\n\s+at .+/g, "")
    .replace(/(?:\/(?:usr|var|opt|tmp|root|app|data|home\/box)\/)\S+/g, "[omitted-path]");
}

export function messageFromErrorBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["error_msg", "error", "detail", "message"]) {
        const entry = record[key];
        if (typeof entry === "string" && entry.length > 0) return entry;
      }
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

export function publicErrorText(text: string, secrets: readonly string[]): string {
  const cleaned = stripPathsInText(messageFromErrorBody(text));
  return stripUrls(redact(cleaned, secrets)).replace(/\s+/g, " ").trim().slice(0, 180);
}

export function toResult(value: unknown): Record<string, unknown> {
  const stripped = stripDanger(value);
  if (stripped !== null && typeof stripped === "object" && !Array.isArray(stripped)) {
    return stripped as Record<string, unknown>;
  }
  if (Array.isArray(stripped)) return { items: stripped };
  if (typeof stripped === "string") return { value: stripped };
  if (typeof stripped === "number" || typeof stripped === "boolean" || stripped === null) {
    return { value: stripped };
  }
  return { value: null };
}

export function asJsonObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new ConnectorError("server", "Tool result was not a JSON object.");
}
