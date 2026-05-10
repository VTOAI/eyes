import { Message, LLMResponse, Tool } from "../agent/types.js";

export interface LLMClient {
  chat(messages: Message[], tools: Tool[]): Promise<LLMResponse>;
}
