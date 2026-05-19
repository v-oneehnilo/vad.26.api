import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { Express, Request, Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { performanceSpec } from "./contract.js";
import { loadSnapshotSync, SnapshotWriter } from "./persistence.js";
import { RealtimeHub } from "./realtime.js";
import {
  createDefaultState,
  isModuleName,
  normalizeAudioFrame,
  normalizeControlCommand,
  ShowStateStore
} from "./state.js";
import { ClientHelloMessage, JsonRecord, PerformanceState } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultSnapshotPath = () => process.env.SHOW_STATE_PATH || path.join(process.cwd(), "data", "show-state.json");

export interface CreateServerOptions {
  initialState?: PerformanceState;
  snapshotPath?: string;
  loadSnapshot?: boolean;
  persist?: boolean;
  controlToken?: string;
  serveClient?: boolean;
}

export interface AppServer {
  app: Express;
  server: http.Server;
  store: ShowStateStore;
  hub: RealtimeHub;
  snapshotWriter: SnapshotWriter | null;
}

export function createServer(options: CreateServerOptions = {}) {
  return createAppServer(options).server;
}

export function createAppServer(options: CreateServerOptions = {}): AppServer {
  const snapshotPath = options.snapshotPath || defaultSnapshotPath();
  const initialState = options.initialState
    || (options.loadSnapshot === false ? null : loadSnapshotSync(snapshotPath))
    || createDefaultState();
  const store = new ShowStateStore(initialState);
  const hub = new RealtimeHub();
  const snapshotWriter = options.persist === false ? null : new SnapshotWriter(snapshotPath);
  const app = express();
  const server = http.createServer(app);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "3mb" }));
  app.use((req, res, next) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type,authorization,x-control-token");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/api/spec", (_req, res) => {
    res.json(performanceSpec);
  });

  app.get("/api/state", (_req, res) => {
    res.json(store.getState());
  });

  app.get("/api/events", (_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*"
    });
    hub.addSse(res);
    res.write("event: state.snapshot\n");
    res.write(`data: ${JSON.stringify({ type: "state.snapshot", state: store.getState() })}\n\n`);
  });

  app.post("/api/mixer/frame", requireToken(options), (req, res) => {
    const frame = normalizeAudioFrame(req.body);
    store.applyAudioFrame(frame);
    snapshotWriter?.schedule(store.getState());
    hub.broadcast(frame);
    broadcastSnapshot(hub, store);
    res.status(202).json({ ok: true, frame, state: store.getState() });
  });

  app.post("/api/modules/:module/state", requireToken(options), (req, res) => {
    const moduleName = req.params.module;
    if (!isModuleName(moduleName)) {
      res.status(400).json({ ok: false, error: "module must be audio, visual, or interaction" });
      return;
    }
    if (!isRecord(req.body)) {
      res.status(400).json({ ok: false, error: "module state patch must be an object" });
      return;
    }
    const patch = isRecord(req.body.patch) ? req.body.patch : req.body;
    store.applyModulePatch(moduleName, patch, String(req.body.source || "rest"));
    snapshotWriter?.schedule(store.getState());
    hub.broadcast({ type: "state.patch", module: moduleName, patch, state: store.getState() });
    broadcastSnapshot(hub, store);
    res.status(202).json({ ok: true, module: moduleName, patch, state: store.getState() });
  });

  app.post("/api/control", requireToken(options), (req, res) => {
    const command = normalizeControlCommand(req.body);
    store.applyControlCommand(command);
    snapshotWriter?.schedule(store.getState());
    const ack = { type: "control.ack", ok: true, command };
    hub.broadcast(command);
    hub.broadcast(ack);
    broadcastSnapshot(hub, store);
    res.status(202).json({ ok: true, command, state: store.getState() });
  });

  app.post("/api/show/reset", requireToken(options), (_req, res) => {
    store.reset("rest");
    snapshotWriter?.schedule(store.getState());
    broadcastSnapshot(hub, store);
    res.status(202).json({ ok: true, state: store.getState() });
  });

  app.post("/api/show/snapshot", requireToken(options), async (_req, res, next) => {
    try {
      if (!snapshotWriter) {
        res.status(202).json({ ok: true, persisted: false, state: store.getState() });
        return;
      }
      await snapshotWriter.flush(store.getState());
      res.status(202).json({ ok: true, persisted: true, state: store.getState() });
    } catch (error) {
      next(error);
    }
  });

  attachWebSocket(server, hub, store, snapshotWriter, options);

  if (options.serveClient) {
    addClientRoutes(app);
  }

  app.use((error: Error, _req: Request, res: Response, _next: express.NextFunction) => {
    res.status(400).json({ ok: false, error: error.message });
  });

  return { app, server, store, hub, snapshotWriter };
}

export function addClientRoutes(app: Express, clientDir = path.join(__dirname, "client")) {
  app.use(express.static(clientDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

function attachWebSocket(
  server: http.Server,
  hub: RealtimeHub,
  store: ShowStateStore,
  snapshotWriter: SnapshotWriter | null,
  options: CreateServerOptions
) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("close", () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, url.searchParams.get("token") || undefined);
    });
  });

  wss.on("connection", (socket: WebSocket, _req: http.IncomingMessage, queryToken?: string) => {
    const fallbackClientId = `ws-${crypto.randomUUID()}`;
    let clientId: string | null = null;
    hub.addSocket(socket);
    hub.send(socket, { type: "state.snapshot", state: store.getState() });

    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as JsonRecord;
        handleWsMessage(message, queryToken, fallbackClientId);
      } catch (error) {
        hub.send(socket, { type: "error", error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("close", () => {
      if (!clientId) return;
      const client = store.removeClient(clientId);
      if (client) {
        snapshotWriter?.schedule(store.getState());
        hub.broadcast({ type: "client.presence", client, clients: store.getState().clients });
        broadcastSnapshot(hub, store);
      }
    });

    function handleWsMessage(message: JsonRecord, queryToken: string | undefined, fallbackId: string) {
      if (typeof message.type !== "string") throw new Error("WebSocket message.type is required");

      if (message.type === "ui.subscribe") {
        hub.send(socket, { type: "state.snapshot", state: store.getState() });
        return;
      }

      if (message.type === "client.hello") {
        const client = store.registerClient(message as unknown as ClientHelloMessage, fallbackId);
        clientId = client.id;
        snapshotWriter?.schedule(store.getState());
        hub.broadcast({ type: "client.presence", client, clients: store.getState().clients });
        hub.send(socket, { type: "state.snapshot", state: store.getState() });
        return;
      }

      if (message.type === "heartbeat") {
        const heartbeatId = String(message.clientId || clientId || fallbackId);
        const client = store.touchClient(heartbeatId, Number(message.sentAt));
        hub.send(socket, { type: "heartbeat.ack", clientId: heartbeatId, client, timestamp: Date.now() });
        return;
      }

      if (!messageHasToken(message, queryToken, options)) {
        hub.send(socket, { type: "error", error: "Unauthorized" });
        return;
      }

      if (message.type === "mixer.audioFrame") {
        const frame = normalizeAudioFrame(message);
        store.applyAudioFrame(frame);
        snapshotWriter?.schedule(store.getState());
        hub.broadcast(frame);
        broadcastSnapshot(hub, store);
        return;
      }

      if (message.type === "module.statePatch") {
        if (!isModuleName(message.module)) throw new Error("module.statePatch.module must be audio, visual, or interaction");
        const patch = isRecord(message.patch) ? message.patch : isRecord(message.state) ? message.state : {};
        store.applyModulePatch(message.module, patch, String(message.source || clientId || "ws"));
        snapshotWriter?.schedule(store.getState());
        hub.broadcast({ type: "state.patch", module: message.module, patch, state: store.getState() });
        broadcastSnapshot(hub, store);
        return;
      }

      if (message.type === "module.telemetry") {
        const event = store.appendEvent("module.telemetry", String(message.module || "unknown"), String(message.source || clientId || "ws"), "Module telemetry", message);
        snapshotWriter?.schedule(store.getState());
        hub.broadcast({ type: "module.telemetry", event, state: store.getState() });
        return;
      }

      if (message.type === "control.command") {
        const command = normalizeControlCommand(message);
        store.applyControlCommand(command);
        snapshotWriter?.schedule(store.getState());
        hub.broadcast(command);
        hub.broadcast({ type: "control.ack", ok: true, command });
        broadcastSnapshot(hub, store);
        return;
      }

      if (message.type === "cue.fire") {
        const event = store.appendEvent("cue.fire", String(message.module || "show"), String(message.source || clientId || "ws"), String(message.cue || "cue.fire"), message);
        snapshotWriter?.schedule(store.getState());
        hub.broadcast({ type: "cue.fire", event, state: store.getState() });
        return;
      }

      throw new Error(`Unsupported WebSocket message: ${message.type}`);
    }
  });
}

function requireToken(options: CreateServerOptions) {
  return (req: Request, res: Response, next: express.NextFunction) => {
    const requiredToken = options.controlToken ?? process.env.CONTROL_TOKEN;
    if (!requiredToken) {
      next();
      return;
    }
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const supplied = req.headers["x-control-token"] || bearer || req.query.token;
    if (supplied === requiredToken) {
      next();
      return;
    }
    res.status(401).json({ ok: false, error: "Unauthorized" });
  };
}

function messageHasToken(message: JsonRecord, queryToken: string | undefined, options: CreateServerOptions) {
  const requiredToken = options.controlToken ?? process.env.CONTROL_TOKEN;
  if (!requiredToken) return true;
  return message.token === requiredToken || message.authToken === requiredToken || queryToken === requiredToken;
}

function broadcastSnapshot(hub: RealtimeHub, store: ShowStateStore) {
  hub.broadcast({ type: "state.snapshot", state: store.getState() });
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function start() {
  const isProduction = process.env.NODE_ENV === "production";
  const { app, server } = createAppServer({
    snapshotPath: defaultSnapshotPath(),
    persist: true,
    serveClient: isProduction
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  }

  const port = Number(process.env.PORT || 3000);
  server.listen(port, "0.0.0.0", () => {
    console.log(`VAD show control listening on http://localhost:${port}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void start();
}
