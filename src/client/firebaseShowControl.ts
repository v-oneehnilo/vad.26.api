import type { ControlCommand, EventLogItem, PerformanceState, ScreenOwner, ScreenRoutePreset } from "../types";

type ConnectionState = "connecting" | "connected" | "offline";

type DashboardClientOptions = {
  initialState: PerformanceState;
  token: string;
  onState: (state: PerformanceState) => void;
  onStatus: (status: ConnectionState) => void;
  onAck: (message: string) => void;
  onError: (message: string) => void;
};

type ClientInfo = PerformanceState["clients"][string];

const env = (import.meta as any).env || {};
const databaseUrl = String(env.VITE_FIREBASE_DATABASE_URL || "").replace(/\/$/, "");

export const firebaseShowId = env.VITE_SHOW_ID || "show-main";

export const isFirebaseRealtimeConfigured = Boolean(databaseUrl);

export function shouldUseFirebaseRealtime() {
  const transport = env.VITE_SHOW_TRANSPORT || "auto";
  if (transport === "firebase") return true;
  if (transport === "websocket") return false;
  return isFirebaseRealtimeConfigured && window.location.hostname.endsWith("vercel.app");
}

const screenIds = [
  "A1",
  "B1", "B2", "B3", "B4", "B5", "B6",
  "C1", "C2", "C3", "C4",
  "D1", "D2", "D3",
  "E1", "F1",
  "L1", "L2", "R1", "R2"
];
const balancedVjScreens = new Set(["A1", "L1", "L2", "R1", "R2"]);
const takeoverVjScreens = new Set(["A1", "B1", "B2", "B3", "B4", "B5", "B6", "L1", "L2", "R1", "R2"]);

export function createFirebaseDashboardClient(options: DashboardClientOptions) {
  if (!isFirebaseRealtimeConfigured) {
    throw new Error("VITE_FIREBASE_DATABASE_URL is not configured");
  }

  const rootPath = `shows/${safePath(firebaseShowId)}`;
  let closed = false;
  let latestState = options.initialState;
  let latestClients: Record<string, ClientInfo> = {};
  let latestEvents: EventLogItem[] = [];
  let lastAckTimestamp = 0;

  const emit = () => {
    options.onState({
      ...latestState,
      clients: latestClients,
      eventLog: latestEvents
    });
  };

  const streams: EventSource[] = [];

  async function boot() {
    try {
      options.onStatus("connecting");
      const existing = await firebaseGet<PerformanceState>(`${rootPath}/state`);
      if (!existing) {
        await firebasePut(`${rootPath}/state`, {
          ...options.initialState,
          updatedAt: Date.now()
        });
      }

      await firebasePut(`${rootPath}/clients/dashboard-main`, makeClientInfo("online"));

      streams.push(openStream(`${rootPath}/state`, async () => {
        if (closed) return;
        const state = await firebaseGet<PerformanceState>(`${rootPath}/state`);
        if (state) latestState = state;
        emit();
      }));

      streams.push(openStream(`${rootPath}/clients`, async () => {
        if (closed) return;
        latestClients = await firebaseGet<Record<string, ClientInfo>>(`${rootPath}/clients`) || {};
        emit();
      }));

      streams.push(openStream(`${rootPath}/events`, async () => {
        if (closed) return;
        const events = await firebaseGet<Record<string, EventLogItem>>(`${rootPath}/events`) || {};
        latestEvents = Object.values(events).sort((a, b) => b.timestamp - a.timestamp).slice(0, 80);
        emit();
      }));

      streams.push(openStream(`${rootPath}/acks`, async () => {
        if (closed) return;
        const ack = findLatestAck(await firebaseGet(`${rootPath}/acks`));
        if (!ack || ack.timestamp <= lastAckTimestamp) return;
        lastAckTimestamp = ack.timestamp;
        options.onAck(`${ack.command || "command"} ack from ${ack.clientId || "module"}`);
      }));

      options.onStatus("connected");
    } catch (error) {
      options.onStatus("offline");
      options.onError(error instanceof Error ? error.message : String(error));
    }
  }

  void boot();

  return {
    async sendControl(input: Omit<ControlCommand, "timestamp"> & { timestamp?: number }) {
      const command: ControlCommand = {
        type: "control.command",
        id: input.id || crypto.randomUUID(),
        module: input.module,
        target: input.target,
        command: input.command,
        value: input.value,
        issuedBy: input.issuedBy || "dashboard-main",
        timestamp: input.timestamp || Date.now()
      };

      await firebasePut(`${rootPath}/commands/${safePath(command.id)}`, withToken(command, options.token));
      await firebasePatch(`${rootPath}/state`, commandToStatePatch(command, latestState));
      await pushEvent(rootPath, "control.command", command.module, command.issuedBy, `${command.command} -> ${command.target}`, {
        id: command.id,
        value: command.value
      });
      options.onAck(`${command.command} sent to ${command.target}`);
      return command;
    },

    async resetShow() {
      const nextState = {
        ...options.initialState,
        updatedAt: Date.now()
      };
      await firebasePut(`${rootPath}/state`, nextState);
      await pushEvent(rootPath, "show.reset", "show", "dashboard-main", "Show state reset", {});
      options.onState(nextState);
      options.onAck("Firebase show state reset");
    },

    async saveSnapshot() {
      await pushEvent(rootPath, "show.snapshot", "show", "dashboard-main", "Firebase state checkpoint requested", {});
      options.onAck("Firebase state is live");
    },

    async close() {
      closed = true;
      streams.forEach((stream) => stream.close());
      await firebaseDelete(`${rootPath}/clients/dashboard-main`).catch(() => undefined);
    }
  };
}

function makeClientInfo(status: "online" | "offline"): ClientInfo {
  const now = Date.now();
  return {
    id: "dashboard-main",
    module: "dashboard",
    role: "control-room",
    status,
    connectedAt: now,
    lastSeen: now,
    latency: null,
    capabilities: ["firebase.realtime", "state.read", "control.command", "dashboard"]
  };
}

function commandToStatePatch(command: ControlCommand, currentState?: PerformanceState) {
  const now = Date.now();
  const patch: Record<string, unknown> = {
    updatedAt: now
  };
  const value = command.value;

  if (command.module === "show") {
    if (command.command === "play") {
      patch["show/status"] = "running";
      patch["show/startedAt"] = now;
      patch["modules/audio/transport"] = "playing";
    }
    if (command.command === "pause") {
      patch["show/status"] = "paused";
      patch["modules/audio/transport"] = "paused";
    }
    if (command.command === "reset") {
      patch["show/status"] = "standby";
      patch["show/positionMs"] = 0;
      patch["show/beat"] = 0;
      patch["show/bar"] = 1;
      patch["modules/audio/transport"] = "stopped";
    }
    if (command.command === "setBpm" && typeof value === "number") {
      patch["show/bpm"] = Math.max(0, value);
      patch["modules/audio/bpm"] = Math.max(0, value);
    }
    if (command.command === "seek" && typeof value === "number") {
      patch["show/positionMs"] = Math.max(0, Math.round(value));
    }
  }

  if (command.module === "audio") {
    if (command.command === "setMasterLevel" && typeof value === "number") {
      patch["modules/audio/masterLevel"] = clampUnit(value);
    }
    if (command.command === "setPreset") patch["modules/audio/activePreset"] = String(value || command.target);
    if (command.command === "setActiveTab") patch["modules/audio/activeTab"] = String(value || command.target);
  }

  if (command.module === "visual" || command.module === "video") {
    if (command.command === "setScene") patch["modules/visual/scene"] = String(value || command.target);
    if (command.command === "setPreset") patch["modules/visual/preset"] = String(value || command.target);
    if (command.command === "setText") patch["modules/visual/text/value"] = String(value || "");
    if (command.command === "setAudioDrive") patch["modules/visual/audioDriveMode"] = String(value || "mic");
    if (command.command === "setFullscreen") patch["modules/visual/fullscreen"] = Boolean(value);
    if (command.command === "setColors" && isRecord(value)) {
      for (const [key, color] of Object.entries(value)) patch[`modules/visual/colors/${key}`] = color;
    }
    if (command.command === "setFx" && isRecord(value)) {
      for (const [key, amount] of Object.entries(value)) patch[`modules/visual/fx/${key}`] = amount;
    }
  }

  if (command.module === "interaction") {
    if (command.command === "setOperationLock") {
      const lockValue = isRecord(value) ? value : {};
      const moduleName = String(lockValue.module || command.target || "");
      const currentModules = new Set((currentState?.operationLock.lockedModules || []).map(String));
      const shouldLock = Boolean(lockValue.locked ?? value);
      if (moduleName) {
        if (shouldLock) currentModules.add(moduleName);
        else currentModules.delete(moduleName);
      }
      const lockedModules = [...currentModules];
      patch["operationLock/locked"] = lockedModules.length > 0;
      patch["operationLock/lockedModules"] = lockedModules;
      patch["operationLock/ownerModule"] = "dashboard";
      patch["operationLock/lockedBy"] = command.issuedBy;
      patch["operationLock/updatedAt"] = now;
    }
    if (["setInteractionMode", "setMode"].includes(command.command)) patch["modules/interaction/mode"] = String(value || command.target);
    if (command.command === "setIntensity" && typeof value === "number") patch["modules/interaction/intensity"] = clampUnit(value);
    if (command.command === "resetTree") {
      patch["modules/interaction/treeGrowth"] = 0;
      patch["modules/interaction/gestureActive"] = false;
      patch["modules/interaction/mode"] = "idle";
      patch["modules/interaction/intensity"] = 0.08;
    }
    if (command.command === "pulseScreen") {
      patch["modules/interaction/screenPulse"] = { source: String(value || command.target), timestamp: now };
    }
    if (command.command === "setScreen") {
      const screenId = String(value || command.target);
      patch["modules/interaction/screenId"] = screenId;
      patch["modules/interaction/role"] = screenId === "MASTER" ? "master" : "screen";
    }
    if (command.command === "setScreenOwner") {
      const screenId = String(command.target || "");
      const owner = normalizeScreenOwner(value);
      if (screenIds.includes(screenId) && owner) {
        patch[`modules/interaction/screenRoutes/${screenId}`] = makeScreenRoute(screenId, owner, now, "control");
        patch["modules/interaction/screenRoutePreset"] = "balanced";
      }
    }
    if (command.command === "setScreenRoutePreset") {
      const preset = normalizeScreenRoutePreset(value || command.target);
      if (preset) {
        patch["modules/interaction/screenRoutePreset"] = preset;
        for (const screenId of screenIds) {
          patch[`modules/interaction/screenRoutes/${screenId}`] = makeScreenRoute(screenId, ownerForPreset(screenId, preset), now, "preset");
        }
      }
    }
    if (command.command === "setScreenAutoRedirect") {
      patch["modules/interaction/screenPresentation/autoRedirect"] = Boolean(value);
    }
    if (command.command === "setScreenDebugVisible") {
      patch["modules/interaction/screenPresentation/showDebug"] = Boolean(value);
    }
    if (command.command === "setScreenMenuVisible") {
      patch["modules/interaction/screenPresentation/showMenu"] = Boolean(value);
    }
    if (command.command === "setScreenPresentation" && isRecord(value)) {
      if (typeof value.autoRedirect === "boolean") patch["modules/interaction/screenPresentation/autoRedirect"] = value.autoRedirect;
      if (typeof value.showDebug === "boolean") patch["modules/interaction/screenPresentation/showDebug"] = value.showDebug;
      if (typeof value.showMenu === "boolean") patch["modules/interaction/screenPresentation/showMenu"] = value.showMenu;
    }
  }

  return patch;
}

function normalizeScreenOwner(value: unknown): ScreenOwner | null {
  return ["vj", "baofa", "off", "diagnostic"].includes(String(value)) ? String(value) as ScreenOwner : null;
}

function normalizeScreenRoutePreset(value: unknown): ScreenRoutePreset | null {
  return ["balanced", "vj_takeover", "baofa_takeover"].includes(String(value)) ? String(value) as ScreenRoutePreset : null;
}

function ownerForPreset(screenId: string, preset: ScreenRoutePreset): ScreenOwner {
  if (preset === "baofa_takeover") return "baofa";
  if (preset === "vj_takeover") return takeoverVjScreens.has(screenId) ? "vj" : "baofa";
  return balancedVjScreens.has(screenId) ? "vj" : "baofa";
}

function makeScreenRoute(screenId: string, owner: ScreenOwner, updatedAt: number, source: string) {
  return {
    screenId,
    owner,
    url: owner === "vj"
      ? `http://localhost:4302/screen/${encodeURIComponent(screenId)}`
      : owner === "baofa"
        ? `http://localhost:4303/screen/${encodeURIComponent(screenId)}`
        : null,
    updatedAt,
    source
  };
}

function openStream(path: string, onRemoteChange: () => void | Promise<void>) {
  const stream = new EventSource(jsonUrl(path));
  stream.addEventListener("open", () => void onRemoteChange());
  stream.addEventListener("put", () => void onRemoteChange());
  stream.addEventListener("patch", () => void onRemoteChange());
  stream.addEventListener("error", () => undefined);
  return stream;
}

async function firebaseGet<T>(path: string): Promise<T | null> {
  const response = await fetch(jsonUrl(path));
  if (!response.ok) throw new Error(`Firebase GET ${path} failed: ${response.status}`);
  return response.json() as Promise<T | null>;
}

async function firebasePut(path: string, value: unknown) {
  await firebaseWrite("PUT", path, value);
}

async function firebasePatch(path: string, value: unknown) {
  await firebaseWrite("PATCH", path, value);
}

async function firebasePost<T>(path: string, value: unknown): Promise<T> {
  return firebaseWrite("POST", path, value) as Promise<T>;
}

async function firebaseDelete(path: string) {
  const response = await fetch(jsonUrl(path), { method: "DELETE" });
  if (!response.ok) throw new Error(`Firebase DELETE ${path} failed: ${response.status}`);
}

async function firebaseWrite(method: "PUT" | "PATCH" | "POST", path: string, value: unknown) {
  const response = await fetch(jsonUrl(path), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Firebase ${method} ${path} failed: ${response.status} ${text}`);
  }
  return response.json().catch(() => null);
}

async function pushEvent(
  rootPath: string,
  type: string,
  module: string | undefined,
  source: string | undefined,
  message: string,
  payload?: unknown
) {
  await firebasePost(`${rootPath}/events`, {
    id: crypto.randomUUID(),
    type,
    module,
    source,
    message,
    timestamp: Date.now(),
    payload
  });
}

function jsonUrl(path: string) {
  return `${databaseUrl}/${path}.json`;
}

function withToken(command: ControlCommand, token: string) {
  return token ? { ...command, token } : command;
}

function findLatestAck(value: unknown) {
  if (!isRecord(value)) return null;
  const acks = Object.values(value)
    .flatMap((commandAcks) => isRecord(commandAcks) ? Object.values(commandAcks) : [])
    .filter(isRecord)
    .map((ack) => ({
      timestamp: Number(ack.timestamp || 0),
      command: typeof ack.command === "string" ? ack.command : undefined,
      clientId: typeof ack.clientId === "string" ? ack.clientId : undefined
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
  return acks[0] || null;
}

function clampUnit(value: number) {
  return Math.max(0, Math.min(1, value));
}

function safePath(value: string) {
  return value.replace(/[.#$/[\]]/g, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
