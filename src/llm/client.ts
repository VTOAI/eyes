import { Message, LLMResponse, Tool } from "../agent/types.js";

export interface StreamCallbacks {
  onToken?: (token: string) => void;
}

export interface LLMClient {
  chat(messages: Message[], tools: Tool[], callbacks?: StreamCallbacks, signal?: AbortSignal): Promise<LLMResponse>;
}
