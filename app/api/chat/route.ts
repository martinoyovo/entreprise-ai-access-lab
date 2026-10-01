import Anthropic from "@anthropic-ai/sdk";
import { userActor } from "@/lib/audit";
import { clientIp } from "@/lib/auth/http";
import { HttpError, withSession } from "@/lib/auth/guard";
import { createMessage } from "@/lib/chat/client";
import { NoChatAccess, runChat, type ChatTurn } from "@/lib/chat/run";

const MAX_TURNS_IN_HISTORY = 40;
const MAX_CHARS = 20_000;

// The browser keeps the transcript and sends it each time; the server stores nothing.
// A user can edit their own history, but that can't widen access: the tool list and
// every tool execution are decided server-side from the database.
function parseHistory(body: unknown): ChatTurn[] {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_TURNS_IN_HISTORY) {
    throw new HttpError(400, `messages must be a non-empty array of at most ${MAX_TURNS_IN_HISTORY} turns`);
  }
  const turns = messages.map((m) => {
    if ((m?.role !== "user" && m?.role !== "assistant") || typeof m.content !== "string" || !m.content.trim() || m.content.length > MAX_CHARS) {
      throw new HttpError(400, "each message needs role user|assistant and non-empty string content");
    }
    return { role: m.role, content: m.content } as ChatTurn;
  });
  if (turns[0].role !== "user" || turns.at(-1)!.role !== "user") throw new HttpError(400, "history must start and end with a user message");
  return turns;
}

export const POST = withSession(async (req, { session }) => {
  const history = parseHistory(await req.json().catch(() => null));
  try {
    const result = await runChat({
      userId: session.user.id,
      userName: session.user.displayName ?? session.user.email,
      history,
      createMessage,
      actor: userActor(session.user.email, clientIp(req)),
    });
    return Response.json(result);
  } catch (e) {
    if (e instanceof NoChatAccess) throw new HttpError(403, "Your roles don't include chat");
    // AnthropicError covers API errors and client setup problems such as a missing API key.
    if (e instanceof Anthropic.AnthropicError) {
      console.error("Claude API error:", e.message);
      throw new HttpError(502, "Claude is unavailable right now");
    }
    throw e;
  }
}, "chat");
