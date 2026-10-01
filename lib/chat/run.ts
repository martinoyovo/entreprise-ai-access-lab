import type Anthropic from "@anthropic-ai/sdk";
import { audit, type Actor } from "../audit";
import { accessFor } from "../authz/access";
import { pool } from "../db";
import { findTool, toolsFor } from "../tools/registry";

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.BetaMessage;
export type CreateMessage = (params: Params) => Promise<Message>;

export type ChatTurn = { role: "user" | "assistant"; content: string };
export type ToolCall = { name: string; input: unknown; ok: boolean; output: string };
export type ChatResult = { reply: string; toolCalls: ToolCall[]; stopReason: string | null };

export class NoChatAccess extends Error {}

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const MAX_TURNS = 8; // cap on tool-use round trips per user message

/**
 * One user message -> Claude, running any tool calls, until Claude answers.
 *
 * The access rule: Claude is only *told about* the tools the user may use. Every tool
 * call is also re-authorized right before it runs, using fresh group data, so a tool
 * removed mid-conversation (or one Claude invents) is refused rather than executed.
 */
export async function runChat(opts: {
  userId: string;
  userName: string;
  history: ChatTurn[];
  createMessage: CreateMessage;
  actor: Actor;
}): Promise<ChatResult> {
  let access = await accessFor(opts.userId);
  if (!access.capabilities.has("chat")) throw new NoChatAccess();

  const tools = toolsFor(access.capabilities);
  const request = connectorConfig(access.capabilities);
  const toolCalls: ToolCall[] = [];
  const messages: Anthropic.Beta.BetaMessageParam[] = opts.history.map((t) => ({ role: t.role, content: t.content }));

  const system =
    `You are the Enterprise AI Access Lab assistant, talking to ${opts.userName}. ` +
    `Their roles: ${access.roles.join(", ")}. ` +
    (tools.length
      ? `You can use these tools: ${tools.map((t) => t.definition.name).join(", ")}.`
      : "You have no tools in this conversation.") +
    " If a request needs a system you have no tool for, say their role doesn't include it" +
    " and that an admin can grant it through their Okta groups. Don't guess at data you can't look up.";

  let response: Message | undefined;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    response = await opts.createMessage({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // If a safety classifier declines, retry server-side on Anthropic's recommended model.
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01", ...request.betas],
      system,
      tools: [...tools.map((t) => t.definition), ...request.tools],
      ...(request.mcp_servers.length && { mcp_servers: request.mcp_servers }),
      messages,
    });
    // Append the full content (not just text) so thinking and tool_use blocks round-trip intact.
    messages.push({ role: "assistant", content: response.content });
    await recordConnectorCalls(response, toolCalls, opts.actor);

    if (response.stop_reason === "refusal") {
      return { reply: "Claude declined to help with this request.", toolCalls, stopReason: "refusal" };
    }
    if (response.stop_reason === "pause_turn") continue; // server-side tool loop paused; resume
    if (response.stop_reason !== "tool_use") break;

    access = await accessFor(opts.userId); // re-check: group membership may have changed
    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const results = await Promise.all(uses.map((use) => execute(use, access.capabilities, toolCalls, opts.actor)));
    // All results go back in ONE user message (splitting them discourages parallel calls).
    messages.push({ role: "user", content: results });
  }

  const reply = (response?.content ?? [])
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { reply, toolCalls, stopReason: response?.stop_reason ?? null };
}

async function execute(
  use: Anthropic.Beta.BetaToolUseBlock,
  capabilities: Set<string>,
  log: ToolCall[],
  actor: Actor,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const tool = findTool(use.name);
  const record = async (ok: boolean, output: string, extra: Record<string, unknown> = {}) => {
    log.push({ name: use.name, input: use.input, ok, output });
    await auditToolCall(actor, use.name, use.input, ok, { capability: tool?.capability ?? null, ...extra });
  };

  if (!tool || !capabilities.has(tool.capability)) {
    const output = `Permission denied: this user's roles don't include ${tool?.capability ?? `a tool named ${use.name}`}.`;
    await record(false, output, { denied: true });
    return { type: "tool_result", tool_use_id: use.id, content: output, is_error: true };
  }
  try {
    const output = JSON.stringify(await tool.run(use.input as Record<string, unknown>));
    await record(true, output, { outputChars: output.length });
    return { type: "tool_result", tool_use_id: use.id, content: output };
  } catch (e) {
    const output = `Tool failed: ${(e as Error).message}`;
    await record(false, output, { error: (e as Error).message });
    return { type: "tool_result", tool_use_id: use.id, content: output, is_error: true };
  }
}

// Inputs are logged (capped) so an investigator can see what was asked for; outputs are
// only measured, since they can hold customer data that shouldn't be copied into the log.
async function auditToolCall(actor: Actor, name: string, input: unknown, ok: boolean, extra: Record<string, unknown>) {
  const json = JSON.stringify(input) ?? "null";
  const loggedInput = json.length > 2000 ? { truncated: json.slice(0, 2000) } : input;
  await audit(pool, actor, ok ? "claude.tool_call" : "claude.tool_call_failed", `tool:${name}`, { input: loggedInput, ...extra });
}

/**
 * MCP connectors run server-side at Anthropic, so there is no execute() step to gate.
 * The only control point is whether we attach the server to the request at all.
 */
function connectorConfig(capabilities: Set<string>) {
  const url = process.env.MCP_DOCS_URL;
  if (!url || !capabilities.has("connector:docs")) return { betas: [], tools: [], mcp_servers: [] };
  return {
    betas: ["mcp-client-2025-11-20"],
    tools: [{ type: "mcp_toolset" as const, mcp_server_name: "docs" }],
    mcp_servers: [{ type: "url" as const, name: "docs", url, authorization_token: process.env.MCP_DOCS_TOKEN || null }],
  };
}

async function recordConnectorCalls(response: Message, log: ToolCall[], actor: Actor) {
  for (const b of response.content) {
    if (b.type !== "mcp_tool_use") continue;
    const name = `${b.server_name}.${b.name}`;
    log.push({ name, input: b.input, ok: true, output: "(ran on the MCP server)" });
    await auditToolCall(actor, name, b.input, true, { capability: "connector:docs", via: "mcp" });
  }
}
