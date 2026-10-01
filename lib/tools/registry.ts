import type Anthropic from "@anthropic-ai/sdk";
import type { Capability } from "../authz/capabilities";
import { crmListOpportunities, crmLookupAccount, githubGetPullRequest, githubSearchIssues } from "./mock-data";

/** A client-side tool: its Claude definition, the capability it needs, and what it runs. */
export type AppTool = {
  capability: Capability;
  definition: Anthropic.Beta.BetaTool;
  run: (input: Record<string, unknown>) => unknown;
};

// strict: true makes Claude's arguments match the schema exactly,
// so run() can trust the input shape.
const tool = (
  capability: Capability,
  name: string,
  description: string,
  properties: Record<string, object>,
  run: AppTool["run"],
): AppTool => ({
  capability,
  run,
  definition: {
    name,
    description,
    strict: true,
    input_schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
  },
});

export const TOOLS: AppTool[] = [
  tool("tool:github", "github_search_issues", "Search issues in a GitHub repository by keyword. Returns matching open and closed issues.",
    { repo: { type: "string", description: "owner/name, e.g. acme/api" }, query: { type: "string" } },
    (i) => githubSearchIssues(String(i.repo), String(i.query))),
  tool("tool:github", "github_get_pull_request", "Get a pull request's title, author, status and changed files.",
    { repo: { type: "string", description: "owner/name" }, number: { type: "integer" } },
    (i) => githubGetPullRequest(String(i.repo), Number(i.number))),
  tool("tool:crm", "crm_lookup_account", "Look up a customer account in the CRM by company name.",
    { name: { type: "string" } },
    (i) => crmLookupAccount(String(i.name))),
  tool("tool:crm", "crm_list_opportunities", "List open sales opportunities, optionally for one account (empty string for all).",
    { account: { type: "string" } },
    (i) => crmListOpportunities(String(i.account))),
];

export const toolsFor = (capabilities: Set<Capability>) => TOOLS.filter((t) => capabilities.has(t.capability));
export const findTool = (name: string) => TOOLS.find((t) => t.definition.name === name);
