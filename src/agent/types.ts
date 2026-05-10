import { Tool } from "@modelcontextprotocol/sdk/types.js";

export type { Tool };

export type Role = "user" | "assistant" | "tool_result";

export type Message =
  | { role: "user" | "assistant"; content: string; timestamp: number }
  | { role: "assistant"; content: string; toolCallId: string; toolName: string; args: Record<string, unknown>; timestamp: number }
  | { role: "tool_result"; content: string; toolCallId: string; toolName: string; timestamp: number };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type LLMResponse =
  | { type: "text"; content: string; usage?: Usage }
  | { type: "tool_call"; toolCall: ToolCall; usage?: Usage };

export interface SessionMetadata {
  id: string;
  name: string;
  createdAt: number;
  lastAccessedAt: number;
}

export interface AgentConfig {
  llmType: "openai" | "anthropic";
  apiKey: string;
  baseURL: string;
  model: string;
  maxIterations: number;
}
