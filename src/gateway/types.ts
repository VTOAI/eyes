export interface GatewayMessage {
  platform: string;
  chatId: string;
  userId: string;
  text: string;
}

export interface MessageGateway {
  /** Unique identifier for this gateway instance */
  readonly name: string;

  /** Start the gateway — connect to platform, begin listening for messages */
  start(): Promise<void>;

  /** Stop the gateway — disconnect, clean up */
  stop(): Promise<void>;

  /** Called for each incoming message. reply() sends a text response back to the same conversation. */
  onMessage: (msg: GatewayMessage, reply: (text: string) => Promise<void>) => Promise<void>;
}
