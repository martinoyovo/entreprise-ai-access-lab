import Anthropic from "@anthropic-ai/sdk";
import type { CreateMessage } from "./run";

let client: Anthropic | undefined;

/** The real Claude call. Tests pass a fake CreateMessage instead. */
export const createMessage: CreateMessage = async (params) => {
  try {
    client ??= new Anthropic(); // reads ANTHROPIC_API_KEY
    return await client.beta.messages.create(params);
  } catch (e) {
    // Missing credentials surface as a plain Error; normalize so the route can map
    // every Claude-side failure to one 502 response.
    throw e instanceof Anthropic.AnthropicError ? e : new Anthropic.AnthropicError((e as Error).message);
  }
};
