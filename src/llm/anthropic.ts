import Anthropic from "@anthropic-ai/sdk";
import { Message, Tool, LLMResponse, ToolCall } from "../agent/types.js";
import { LLMClient } from "./client.js";

type AnthropicToolUseBlock = Anthropic.Messages.ToolUseBlock;
type AnthropicTextBlock = Anthropic.Messages.TextBlock;

function isToolResult(m: Message): m is Extract<Message, { role: "tool_result" }> {
  return m.role === "tool_result";
}

function isAssistantToolCall(m: Message): m is Extract<Message, { role: "assistant"; toolCallId: string }> {
  return m.role === "assistant" && "toolCallId" in m;
}

function toAnthropicMessages(msgs: Message[]): Anthropic.Messages.MessageParam[] {
  const result: Anthropic.Messages.MessageParam[] = [];

  for (const m of msgs) {
    if (m.role === "user" || m.role === "assistant") {
      if (isAssistantToolCall(m)) {
        const content: Anthropic.Messages.ContentBlockParam[] = [];
        if (m.content) {
          content.push({ type: "text", text: m.content });
        }
        content.push({ type: "tool_use", id: m.toolCallId, name: m.toolName, input: m.args });
        result.push({ role: "assistant", content });
      } else {
        result.push({ role: m.role, content: m.content });
      }
    } else if (isToolResult(m)) {
      result.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
      });
    }
  }

  return result;
}

function toAnthropicTools(tools: Tool[]): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
  }));
}

export class AnthropicClient implements LLMClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(messages: Message[], tools: Tool[]): Promise<LLMResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      messages: toAnthropicMessages(messages),
      tools: tools.length > 0 ? toAnthropicTools(tools) : undefined,
    });

    if (!response.content || response.content.length === 0) {
      throw new Error("Anthropic API returned empty content array");
    }

    // Find the first tool_use block — if present, return it as a tool_call
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const toolUse = block as AnthropicToolUseBlock;
        const toolCall: ToolCall = {
          id: toolUse.id,
          name: toolUse.name,
          args: toolUse.input as Record<string, unknown>,
        };
        return { type: "tool_call", toolCall };
      }
    }

    // No tool_use found — concatenate all text blocks
    const textParts = response.content
      .filter((b): b is AnthropicTextBlock => b.type === "text")
      .map((b) => b.text);

    return { type: "text", content: textParts.join("\n") || "" };
  }
}
