import { z } from "zod";
import { confirmField } from "./confirm.js";
import { fixedError } from "./zod-messages.js";

export { confirmField };

const actionError = fixedError("action must be a published Seafile operation for this tool");

export const stringMapField = z
  .record(z.string().min(1).max(120), z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .describe("Path or query parameters. Path keys match the route placeholders, such as repo_id.");

export const bodyField = z
  .union([z.record(z.string().min(1).max(120), z.unknown()), z.array(z.unknown())])
  .optional()
  .describe(
    "Free-form JSON or form body. /api2 routes are sent as form fields. /api/v2.1 routes are sent as JSON. Secrets are redacted in previews.",
  );

export function actionField(actions: [string, ...string[]]): z.ZodType<string> {
  return z.enum(actions, { error: actionError }).describe("Seafile operation to call.");
}

export function toolInputSchema(actions: [string, ...string[]], writes: boolean) {
  const shape = {
    action: actionField(actions),
    params: stringMapField.describe("Path parameters, such as repo_id or group_id."),
    query: stringMapField.describe(
      "Query parameters, such as p for a library path or q for search.",
    ),
    body: bodyField,
    ...(writes ? { confirm: confirmField } : {}),
  };
  return z.object(shape);
}

export type ToolInput = {
  action: string;
  params?: Readonly<Record<string, string | number | boolean>> | undefined;
  query?: Readonly<Record<string, string | number | boolean>> | undefined;
  body?: unknown;
  confirm?: true | undefined;
};
