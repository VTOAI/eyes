import OpenAI from "openai";
import { Message, Tool, LLMResponse, ToolCall, Usage } from "../agent/types.js";
import { LLMClient, StreamCallbacks } from "./client.js";

function isToolResult(m: Message): m is Extract<Message, { role: "tool_result" }> {
  return m.role === "tool_result";
}

function isAssistantToolCall(m: Message): m is Extract<Message, { role: "assistant"; toolCallId: string }> {
  return m.role === "assistant" && "toolCallId" in m;
}

function toOpenAIMessages(msgs: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return msgs.map((m) => {
    if (isToolResult(m)) {
      return {
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content,
      } as OpenAI.Chat.ChatCompletionMessageParam;
    }

    if (isAssistantToolCall(m)) {
      const msg: Record<string, unknown> = {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: m.toolCallId, type: "function", function: { name: m.toolName, arguments: JSON.stringify(m.args) } },
        ],
      };
      if (m.reasoningContent) {
        (msg as any).reasoning_content = m.reasoningContent;
      }
      return msg as unknown as OpenAI.Chat.ChatCompletionMessageParam;
    }

    const msg: Record<string, unknown> = { role: m.role as "system" | "user" | "assistant", content: m.content };
    if ("reasoningContent" in m && m.reasoningContent) {
      (msg as any).reasoning_content = m.reasoningContent;
    }
    return msg as unknown as OpenAI.Chat.ChatCompletionMessageParam;
  });
}

function toOpenAITools(tools: Tool[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.inputSchema,
    },
  }));
}

export class OpenAICompatibleClient implements LLMClient {
  private client: OpenAI;
  private model: string;
  private maxOutputTokens: number;

  constructor(apiKey: string, baseURL: string, model: string, maxOutputTokens = 4096) {
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model;
    this.maxOutputTokens = maxOutputTokens;
  }

  async chat(messages: Message[], tools: Tool[], callbacks?: StreamCallbacks, signal?: AbortSignal): Promise<LLMResponse> {
    const params: OpenAI.ChatCompletionCreateParams = {
      model: this.model,
      max_tokens: this.maxOutputTokens,
      messages: toOpenAIMessages(messages),
      tools: tools.length > 0 ? toOpenAITools(tools) : undefined,
    };

    // Non-streaming path (no callbacks, no signal)
    if (!callbacks && !signal) {
      const response = await this.client.chat.completions.create({ ...params, stream: false });
      const choice = response.choices[0];
      if (!choice) throw new Error("OpenAI API returned empty choices array");

      let usage: Usage | undefined;
      if (response.usage) {
        usage = { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens };
      }

      const reasoningContent = (choice.message as any).reasoning_content as string | undefined;

      if (choice.finish_reason === "tool_calls" && choice.message.tool_calls) {
        const tc = choice.message.tool_calls[0];
        const toolCall: ToolCall = {
          id: tc.id,
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments || "{}"),
        };
        return { type: "tool_call", toolCall, usage, ...(reasoningContent ? { reasoningContent } : {}) };
      }

      return { type: "text", content: choice.message.content || "", usage, ...(reasoningContent ? { reasoningContent } : {}) };
    }

    // Streaming path
    const stream = await this.client.chat.completions.create(
      { ...params, stream: true, stream_options: { include_usage: true } },
      { signal }
    );

    let content = "";
    let reasoningContent = "";
    const toolAccums = new Map<number, { id: string; name: string; args: string }>();
    let usage: Usage | undefined;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) {
        // Usage may be in the final chunk with no choices
        if ((chunk as any).usage) {
          const u = (chunk as any).usage;
          usage = { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
        }
        continue;
      }
      const delta = choice.delta as Record<string, unknown>;

      if (delta.content) {
        content += delta.content as string;
        callbacks?.onToken?.(delta.content as string);
      }

      if (delta.reasoning_content) {
        reasoningContent += delta.reasoning_content as string;
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls as any[]) {
          const idx = tc.index;
          if (!toolAccums.has(idx)) {
            toolAccums.set(idx, { id: "", name: "", args: "" });
          }
          const acc = toolAccums.get(idx)!;
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      }
    }

    if (toolAccums.size > 0) {
      const first = toolAccums.get(0)!;
      if (first.name) {
        try {
          return {
            type: "tool_call",
            toolCall: { id: first.id, name: first.name, args: JSON.parse(first.args || "{}") },
            usage,
            ...(reasoningContent ? { reasoningContent } : {}),
          };
        } catch {
          // JSON parse failed — treat as text
        }
      }
    }

    return { type: "text", content, usage, ...(reasoningContent ? { reasoningContent } : {}), };
  }
}
