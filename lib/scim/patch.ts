import { ScimError } from "./http";

const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export type PatchOp = { op: "add" | "remove" | "replace"; path?: string; value?: unknown };

/**
 * Validates a PatchOp body and normalises IdP differences:
 * - Entra sends capitalised ops ("Replace", "Add"); Okta sends lowercase.
 * - Both may omit `path` and put a map of attributes in `value` instead.
 */
export function parsePatch(body: Record<string, unknown>): PatchOp[] {
  const schemas = body.schemas;
  if (!Array.isArray(schemas) || !schemas.includes(PATCH_SCHEMA)) {
    throw new ScimError(400, `PATCH body must declare schema ${PATCH_SCHEMA}`, "invalidSyntax");
  }
  if (!Array.isArray(body.Operations)) throw new ScimError(400, "PATCH body needs an Operations array", "invalidSyntax");
  return body.Operations.map((raw: Record<string, unknown>) => {
    const op = String(raw?.op ?? "").toLowerCase();
    if (op !== "add" && op !== "remove" && op !== "replace") {
      throw new ScimError(400, `Unsupported PATCH op "${raw?.op}"`, "invalidSyntax");
    }
    const path = typeof raw.path === "string" && raw.path.trim() ? raw.path.trim() : undefined;
    if (op === "remove" && !path) throw new ScimError(400, "remove requires a path", "noTarget");
    return { op, path, value: raw.value };
  });
}

/**
 * Entra ID (before its SCIM compliance flag) sends booleans as strings: "False".
 * Treat anything that isn't clearly true as a value error instead of guessing.
 */
export function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && /^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
  throw new ScimError(400, `Expected a boolean, got ${JSON.stringify(v)}`, "invalidValue");
}
