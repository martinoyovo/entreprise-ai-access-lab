import type { Capability } from "../authz/capabilities";
import { accessFor, type Access } from "../authz/access";
import { getSessionUser, tokenFromRequest, type SessionUser } from "./session";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Ctx = { params: Promise<Record<string, string>> };
type Authed = { session: SessionUser; access: Access; params: Record<string, string> };

/**
 * Wraps an API route: requires a live session and, optionally, a capability.
 * Access is resolved from the database on every call (never from the cookie),
 * so group or role changes apply to the next request.
 */
export function withSession(handler: (req: Request, ctx: Authed) => Promise<Response>, need?: Capability) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      const session = await getSessionUser(tokenFromRequest(req));
      if (!session) throw new HttpError(401, "Not signed in");
      const access = await accessFor(session.user.id);
      if (need && !access.capabilities.has(need)) throw new HttpError(403, `Requires the ${need} capability`);
      return await handler(req, { session, access, params: (await ctx?.params) ?? {} });
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      console.error(e);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
