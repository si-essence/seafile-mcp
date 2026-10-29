import { TEXT_BYTE_CAP } from "./constants.js";
import { ConnectorError } from "./errors.js";
import { assertAllowedFileUrl, libraryPath, resolveFileUrl } from "./fileserver.js";
import type { QueryMap } from "./http.js";
import type { Runtime } from "./runtime.js";
import { withWrite } from "./write-gate.js";

const DOWNLOAD_WARNING =
  "This mints a download token and fetches file text. The token is not returned. Text only, size capped.";
const UPLOAD_WARNING =
  "This mints an upload token and writes file text. The token is not returned. Text only, size capped. replace defaults to false.";
const OVERWRITE_WARNING = "This overwrites an existing file at the named library path.";

interface TextArgs {
  readonly params?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly query?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly body?: unknown;
  readonly confirm?: true | undefined;
}

function requiredRepo(params: TextArgs["params"]): string {
  const repo = params?.["repo_id"];
  if (typeof repo !== "string" || repo.trim().length === 0) {
    throw new ConnectorError("input", "Missing path parameter repo_id.");
  }
  return repo.trim();
}

function requiredPath(query: TextArgs["query"], body: unknown): string {
  const fromQuery = query?.["p"];
  const fromBody =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)["path"]
      : undefined;
  const raw = typeof fromQuery === "string" ? fromQuery : fromBody;
  if (typeof raw !== "string") {
    throw new ConnectorError("input", "Missing library path. Set query p.");
  }
  return libraryPath(raw);
}

function parentDir(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return "/";
  return path.slice(0, slash);
}

function fileName(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  if (name.length === 0) {
    throw new ConnectorError("input", "Library path must name a file.");
  }
  return name;
}

function textOf(body: unknown): { text: string; replace: boolean } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ConnectorError("input", "write_text_file body must be an object with text.");
  }
  const record = body as Record<string, unknown>;
  if (typeof record["text"] !== "string") {
    throw new ConnectorError("input", "write_text_file body.text must be a string.");
  }
  const bytes = Buffer.byteLength(record["text"]);
  if (bytes > TEXT_BYTE_CAP) {
    throw new ConnectorError("input", "Text file is larger than the 256 KiB cap.");
  }
  return { text: record["text"], replace: record["replace"] === true };
}

function urlFrom(result: Record<string, unknown>): string {
  const value = result["value"] ?? result["url"] ?? result["link"];
  if (typeof value === "string" && (value.startsWith("http") || value.startsWith("/")))
    return value;
  throw new ConnectorError("server", "Seafile did not return a file server URL.");
}

function allowFor(runtime: Runtime): (url: URL) => void {
  return (url) => {
    assertAllowedFileUrl(url, runtime.config.baseUrl, runtime.config.fileServerUrl);
  };
}

function isTextContent(contentType: string, text: string): boolean {
  if (text.includes("\u0000")) return false;
  const type = contentType.toLowerCase();
  if (type.length === 0) return true;
  if (type.startsWith("text/")) return true;
  if (type.includes("json") || type.includes("xml") || type.includes("javascript")) return true;
  if (type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/"))
    return false;
  if (type.includes("octet-stream") || type.includes("pdf") || type.includes("zip")) return false;
  return true;
}

function multipart(
  parent: string,
  name: string,
  text: string,
  replace: boolean,
): { body: string; contentType: string } {
  const boundary = `seafile${Date.now().toString(16)}`;
  const replaceField = replace ? "1" : "0";
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="parent_dir"`,
    "",
    parent,
    `--${boundary}`,
    `Content-Disposition: form-data; name="replace"`,
    "",
    replaceField,
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${name.replace(/"/g, "")}"`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function readTextFile(
  runtime: Runtime,
  args: TextArgs,
): Promise<Record<string, unknown>> {
  const repoId = requiredRepo(args.params);
  const path = requiredPath(args.query, args.body);
  const query: QueryMap = { p: path, reuse: "1" };
  const apiPath = `/api2/repos/${encodeURIComponent(repoId)}/file/`;
  const warnings = [DOWNLOAD_WARNING, `Target library ${repoId} path ${path}.`];
  return withWrite(
    runtime,
    args.confirm,
    {
      method: "GET",
      path: apiPath,
      query,
      summary: "Read a text file from a library. Download link, then a same-host fetch.",
      warnings,
      steps: [
        { method: "GET", path: apiPath, query },
        { method: "GET", path: "(download URL on SEAFILE_URL or SEAFILE_FILE_SERVER_URL)" },
      ],
    },
    async () => {
      const linked = await runtime.client.exchange({
        method: "GET",
        path: apiPath,
        query,
        body: undefined,
        encoding: "json",
        ttlSec: 0,
      });
      const fileUrl = resolveFileUrl(urlFrom(linked), runtime.config.baseUrl);
      const fetched = await runtime.client.exchangeAbsolute({
        url: fileUrl,
        method: "GET",
        maxBytes: TEXT_BYTE_CAP,
        auth: false,
        allow: allowFor(runtime),
      });
      if (!isTextContent(fetched.contentType, fetched.text)) {
        throw new ConnectorError("invalid", "File is not text.");
      }
      return {
        repo_id: repoId,
        path,
        bytes: Buffer.byteLength(fetched.text),
        text: fetched.text,
      };
    },
  );
}

export async function writeTextFile(
  runtime: Runtime,
  args: TextArgs,
): Promise<Record<string, unknown>> {
  const repoId = requiredRepo(args.params);
  const path = requiredPath(args.query, args.body);
  const { text, replace } = textOf(args.body);
  const parent = parentDir(path);
  const name = fileName(path);
  const apiPath = `/api2/repos/${encodeURIComponent(repoId)}/upload-link/`;
  const query: QueryMap = { p: parent, replace: replace ? "1" : "0" };
  const warnings = [UPLOAD_WARNING, `Target library ${repoId} path ${path}.`];
  if (replace) warnings.push(OVERWRITE_WARNING);
  const previewBody = {
    parent_dir: parent,
    filename: name,
    replace,
    bytes: Buffer.byteLength(text),
    text,
  };
  return withWrite(
    runtime,
    args.confirm,
    {
      method: "POST",
      path: apiPath,
      query,
      body: previewBody,
      summary: "Write a text file into a library. Upload link, then multipart POST.",
      warnings,
      steps: [
        { method: "GET", path: apiPath, query },
        {
          method: "POST",
          path: "(file server upload-api on SEAFILE_URL or SEAFILE_FILE_SERVER_URL)",
          body: previewBody,
        },
      ],
    },
    async () => {
      const linked = await runtime.client.exchange({
        method: "GET",
        path: apiPath,
        query,
        body: undefined,
        encoding: "json",
        ttlSec: 0,
      });
      const uploadUrl = resolveFileUrl(urlFrom(linked), runtime.config.baseUrl);
      const form = multipart(parent, name, text, replace);
      if (Buffer.byteLength(form.body) > 1_000_000) {
        throw new ConnectorError("input", "Text file is larger than the request cap.");
      }
      const sent = await runtime.client.exchangeAbsolute({
        url: uploadUrl,
        method: "POST",
        body: form.body,
        contentType: form.contentType,
        maxBytes: 1_000_000,
        auth: false,
        allow: allowFor(runtime),
      });
      return {
        repo_id: repoId,
        path,
        bytes: Buffer.byteLength(text),
        replace,
        status: sent.status,
      };
    },
  );
}
