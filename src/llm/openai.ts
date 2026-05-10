import OpenAI from "openai";
import { Message, LLMResponse, ToolCall } from "../agent/types.js";
import { LLMClient } from "./client.js";

function toOpenAIMessages(msgs: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return msgs.map((m) => {
    switch (m.role) {
      case "user":
        return { role: "user", content: m.content };
      case "assistant":
        if (m.toolCallId) {
          return {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: m.toolCallId, type: "function", function: { name: m.toolName!, arguments: "" } },
            ],
          } as OpenAI.Chat.ChatCompletionMessageParam;
        }
        return { role: "assistant", content: m.content };
      case "tool_result":
        return {
          role: "tool",
          tool_call_id: m.toolCallId!,
          content: m.content,
        } as OpenAI.Chat.ChatCompletionMessageParam;
      default:
        return { role: "user", content: m.content };
    }
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
