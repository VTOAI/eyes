import OpenAI from "openai";
import { Message, Tool, LLMResponse, ToolCall } from "../agent/types.js";
import { LLMClient } from "./client.js";

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
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: m.toolCallId, type: "function", function: { name: m.toolName, arguments: JSON.stringify(m.args) } },
        ],
      } as OpenAI.Chat.ChatCompletionMessageParam;
    }

    return { role: m.role as "user" | "assistant", content: m.content };
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

  constructor(apiKey: string, baseURL: string, model: string) {
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model;
  }

  async chat(messages: Message[], tools: Tool[]): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(messages),
      tools: tools.length > 0 ? toOpenAITools(tools) : undefined,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("OpenAI API returned empty choices array");
    }

    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls) {
      const tc = choice.message.tool_calls[0];
      const toolCall: ToolCall = {
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments || "{}"),
      };
      return { type: "tool_call", toolCall };
    }

    return { type: "text", content: choice.message.content || "" };
  }
}
