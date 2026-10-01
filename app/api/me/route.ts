import { withSession } from "@/lib/auth/guard";
import { toolsFor } from "@/lib/tools/registry";

export const GET = withSession(async (_req, { session, access }) =>
  Response.json({
    user: session.user,
    groups: session.groups,
    roles: access.roles,
    capabilities: [...access.capabilities].sort(),
    tools: toolsFor(access.capabilities).map((t) => t.definition.name),
    expiresAt: session.expiresAt,
  }),
);
