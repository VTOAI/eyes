import { Tool } from "@modelcontextprotocol/sdk/types.js";

export type { Tool };

export type Role = "user" | "assistant" | "tool_result";

export interface Message {
  role: Role;
  content: string;
  toolCallId?: string;
  toolName?: string;
  timestamp: number;
}

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
