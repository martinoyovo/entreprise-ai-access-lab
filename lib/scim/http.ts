import { createHash, timingSafeEqual } from "node:crypto";
import { clientIp } from "../auth/http";

export const SCIM_CONTENT_TYPE = "application/scim+json";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

/** Thrown anywhere in a handler; withScim turns it into an RFC 7644 §3.12 error body. */
export class ScimError extends Error {
  constructor(public status: number, detail: string, public scimType?: string) {
    super(detail);
  }
}

export function scimJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": SCIM_CONTENT_TYPE, ...headers },
  });
}

function errorResponse(e: ScimError) {
  return scimJson(
    { schemas: [ERROR_SCHEMA], status: String(e.status), detail: e.message, ...(e.scimType && { scimType: e.scimType }) },
    e.status,
  );
}

// Hash both sides so timingSafeEqual gets equal-length buffers and the comparison
// doesn't leak how many leading characters of a guessed token were right.
function tokenMatches(given: string): boolean {
  const expected = process.env.SCIM_BEARER_TOKEN;
  if (!expected) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(given), h(expected));
}

type Ctx = { params: Promise<Record<string, string>> };
type Handler = (req: Request, params: Record<string, string>) => Promise<Response>;

/** Wraps a route handler with bearer auth and SCIM error mapping. */
export function withScim(handler: Handler, { auth = true } = {}) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      if (auth) {
        const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
        if (!m || !tokenMatches(m[1].trim())) throw new ScimError(401, "Invalid or missing bearer token");
      }
      return await handler(req, (await ctx?.params) ?? {});
    } catch (e) {
      if (e instanceof ScimError) return errorResponse(e);
      // 23505 = unique_violation. Also reached when two retries of the same POST race.
      if ((e as { code?: string }).code === "23505") {
        return errorResponse(new ScimError(409, "A resource with this userName, email or displayName already exists", "uniqueness"));
      }
      console.error(e);
      return errorResponse(new ScimError(500, "Internal server error"));
    }
  };
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ScimError(400, "Request body is not valid JSON", "invalidSyntax");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ScimError(400, "Request body must be a JSON object", "invalidSyntax");
  }
  return body as Record<string, unknown>;
}

/** Base URL for meta.location. Behind a tunnel, req.url is often localhost, so prefer config. */
export function baseUrl(req: Request): string {
  return (process.env.APP_BASE_URL ?? new URL(req.url).origin).replace(/\/$/, "") + "/scim/v2";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);

/** Audit actor for SCIM calls. One shared bearer token means the IdP is the only possible caller. */
export const scimActor = (req: Request) => ({ actor: "scim", ip: clientIp(req) });
