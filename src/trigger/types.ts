export interface AlertEvent {
  source: string;
  alertId: string;
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  raw: unknown;
}

import { IncomingMessage, ServerResponse } from "node:http";

export interface AlertReceiver {
  readonly name: string;
  readonly path: string;
  parse(body: Record<string, unknown>): AlertEvent[];
  onAlert: (event: AlertEvent) => Promise<string>;
  onMessage?: (userId: string, message: string) => Promise<string>;
  decryptMessage?: (encrypted: string) => string;
  verify?: (req: IncomingMessage, res: ServerResponse) => boolean;
}
