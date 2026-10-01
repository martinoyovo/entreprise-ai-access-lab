type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

export const BASE = "https://lab.example.com/scim/v2";

/** Calls a route handler the way Next.js would, returning status, headers and parsed body. */
export async function call(
  handler: Handler,
  { path = "/", method = "GET", body, params = {}, token = "test-token" }:
    { path?: string; method?: string; body?: unknown; params?: Record<string, string>; token?: string | null } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/scim+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const req = new Request(BASE + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const res = await handler(req, { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

export const userBody = (email: string, extra: Record<string, unknown> = {}) => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
  userName: email,
  name: { givenName: "Ada", familyName: "Lovelace" },
  emails: [{ value: email, type: "work", primary: true }],
  active: true,
  ...extra,
});

export const patch = (...Operations: unknown[]) => ({
  schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  Operations,
});
