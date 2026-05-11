import Anthropic from "@anthropic-ai/sdk";
import { Message, Tool, LLMResponse, Usage } from "../agent/types.js";
import { LLMClient, StreamCallbacks } from "./client.js";

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
    if (m.role === "system") continue;
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

  async chat(messages: Message[], tools: Tool[], callbacks?: StreamCallbacks, signal?: AbortSignal): Promise<LLMResponse> {
    const systemMessages = messages.filter((m) => m.role === "system");
    const system = systemMessages.length > 0
      ? systemMessages.map((m) => ({ type: "text" as const, text: m.content }))
      : undefined;

    const params: Anthropic.Messages.MessageCreateParams = {
      model: this.model,
      max_tokens: 4096,
      messages: toAnthropicMessages(messages),
      tools: tools.length > 0 ? toAnthropicTools(tools) : undefined,
      ...(system ? { system } : {}),
    };

    // Non-streaming path
    if (!callbacks && !signal) {
      const response = await this.client.messages.create({ ...params, stream: false });
      const result = parseAnthropicResponse(response.content);
      if (response.usage) {
        result.usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      }
      return result;
    }

    // Streaming path
    const stream = await this.client.messages.create(
      { ...params, stream: true },
      { signal }
    );

    let textContent = "";
    let toolBlock: { id: string; name: string; inputJson: string } | null = null;
    let usage: Usage | undefined;

    for await (const event of stream) {
      switch (event.type) {
        case "message_start": {
          const msg = (event as any).message;
          if (msg?.usage) {
            usage = { inputTokens: msg.usage.input_tokens, outputTokens: 0 };
          }
          break;
        }
        case "message_delta": {
          const delta = (event as any).delta || event;
          if (delta.usage) {
            usage = usage
              ? { ...usage, outputTokens: delta.usage.output_tokens }
              : { inputTokens: 0, outputTokens: delta.usage.output_tokens ?? 0 };
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            textContent += delta.text;
            callbacks?.onToken?.(delta.text);
          } else if (delta.type === "input_json_delta" && toolBlock) {
            toolBlock.inputJson += delta.partial_json;
          }
          break;
        }
        case "content_block_start": {
          const block = event.content_block;
          if (block.type === "tool_use") {
            toolBlock = { id: block.id, name: block.name, inputJson: "" };
          }
          break;
        }
      }
    }

    if (toolBlock && toolBlock.name) {
      try {
        return {
          type: "tool_call",
          toolCall: { id: toolBlock.id, name: toolBlock.name, args: JSON.parse(toolBlock.inputJson || "{}") },
          usage,
        };
      } catch {
        // Fall through to text
      }
    }

    return { type: "text", content: textContent, usage };
  }
}

function parseAnthropicResponse(content: Anthropic.Messages.ContentBlock[]): LLMResponse {
  if (!content || content.length === 0) {
    throw new Error("Anthropic API returned empty content array");
  }

  for (const block of content) {
    if (block.type === "tool_use") {
      const toolUse = block as AnthropicToolUseBlock;
      return {
        type: "tool_call",
        toolCall: { id: toolUse.id, name: toolUse.name, args: toolUse.input as Record<string, unknown> },
      };
    }
  }

  const textParts = content
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text);

  return { type: "text", content: textParts.join("\n") || "" };
}
