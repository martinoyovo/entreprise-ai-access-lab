import { ScimError } from "./http";

const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const MAX_COUNT = 200;

/**
 * Parses the only filter shape IdPs send for provisioning: `attr eq "value"`.
 * Okta uses `userName eq "..."`, Entra uses `userName eq "..."`/`externalId eq "..."`
 * and `displayName eq "..."` for groups. Anything richer gets a SCIM invalidFilter error
 * rather than being silently ignored (ignoring it would return every user).
 */
export function parseEqFilter(filter: string | null, allowed: string[]): { attr: string; value: string } | null {
  if (!filter) return null;
  const m = /^\s*([\w.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  const attr = m && allowed.find((a) => a.toLowerCase() === m[1].toLowerCase());
  if (!m || !attr) {
    throw new ScimError(400, `Unsupported filter. Supported: ${allowed.map((a) => `${a} eq "..."`).join(", ")}`, "invalidFilter");
  }
  return { attr, value: m[2].replace(/\\(.)/g, "$1") };
}

/** SCIM pagination is 1-based (startIndex) with a page size (count). */
export function parsePaging(url: URL) {
  const int = (name: string) => {
    const v = url.searchParams.get(name);
    return v === null || !/^-?\d+$/.test(v) ? null : Number(v);
  };
  const startIndex = Math.max(1, int("startIndex") ?? 1);
  const count = Math.min(MAX_COUNT, Math.max(0, int("count") ?? 100));
  return { startIndex, count, offset: startIndex - 1 };
}

export function listResponse(resources: unknown[], totalResults: number, startIndex: number) {
  return { schemas: [LIST_SCHEMA], totalResults, startIndex, itemsPerPage: resources.length, Resources: resources };
}

/** `excludedAttributes=members` lets IdPs fetch big groups cheaply (Entra and Okta both use it). */
export function excludes(url: URL, attr: string): boolean {
  const v = url.searchParams.get("excludedAttributes") ?? "";
  return v.split(",").some((a) => a.trim().toLowerCase() === attr.toLowerCase());
}
