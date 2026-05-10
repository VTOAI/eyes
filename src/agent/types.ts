import { Tool } from "@modelcontextprotocol/sdk/types.js";

export type { Tool };

export type Role = "user" | "assistant" | "tool_result";

export type Message =
  | { role: "user" | "assistant"; content: string; timestamp: number }
  | { role: "assistant"; content: string; toolCallId: string; toolName: string; timestamp: number }
  | { role: "tool_result"; content: string; toolCallId: string; toolName: string; timestamp: number };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type LLMResponse =
  | { type: "text"; content: string }
  | { type: "tool_call"; toolCall: ToolCall };

export interface AgentConfig {
  llmType: "openai" | "anthropic";
  apiKey: string;
  baseURL: string;
  model: string;
  maxIterations: number;
}
