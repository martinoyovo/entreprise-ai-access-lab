// Every capability the app knows how to enforce. Roles can only be granted these.
export const CAPABILITIES = {
  chat: "Use the Claude chat",
  "tool:github": "GitHub tools: search issues, read pull requests (mock data)",
  "tool:crm": "CRM tools: look up accounts and open opportunities (mock data)",
  "connector:docs": "Docs MCP connector (remote MCP server set by MCP_DOCS_URL)",
  "admin:roles": "Manage roles and group-to-role mappings",
  "admin:audit": "Read the audit log",
} as const;

export type Capability = keyof typeof CAPABILITIES;

export const isCapability = (c: unknown): c is Capability => typeof c === "string" && c in CAPABILITIES;
