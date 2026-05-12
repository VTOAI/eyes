export interface Messenger {
  readonly name: string;
  send(to: string[], title: string, content: string): Promise<void>;
}
