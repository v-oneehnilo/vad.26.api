import type { Response } from "express";
import WebSocket from "ws";

export type ServerMessage = {
  type: string;
};

export class RealtimeHub {
  private readonly sockets = new Set<WebSocket>();
  private readonly sseClients = new Set<Response>();

  addSocket(socket: WebSocket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
  }

  addSse(response: Response) {
    this.sseClients.add(response);
    response.on("close", () => this.sseClients.delete(response));
  }

  send<T extends ServerMessage>(socket: WebSocket, message: T) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  broadcast<T extends ServerMessage>(message: T) {
    const payload = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
    for (const client of this.sseClients) {
      client.write(`event: ${message.type}\n`);
      client.write(`data: ${payload}\n\n`);
    }
  }
}
