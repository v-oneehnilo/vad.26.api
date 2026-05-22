import crypto from "node:crypto";
import {
  AudioFrame,
  ClientHelloMessage,
  ClientInfo,
  ControlCommand,
  EventLogItem,
  InteractionModuleState,
  JsonRecord,
  MODULE_NAMES,
  ModuleName,
  PerformanceState,
  ScreenOwner,
  ScreenRouteEntry,
  ScreenRoutePreset
} from "./types.js";

const DEFAULT_BANDS = Array.from({ length: 16 }, () => 0);

export const SCREEN_IDS = [
  "A1",
  "B1", "B2", "B3", "B4", "B5", "B6",
  "C1", "C2", "C3", "C4",
  "D1", "D2", "D3",
  "E1", "F1",
  "L1", "L2", "R1", "R2"
] as const;

const SCREEN_TOPOLOGY = [
  ["L1", "A1", "R1"],
  ["L2", "B1", "B2", "B3", "B4", "B5", "B6", "R2"],
  ["C1", "C2", "C3", "C4"],
  ["D1", "D2", "D3"],
  ["E1", "F1"]
];

const VJ_SCREEN_IDS = new Set(["A1", "L1", "L2", "R1", "R2"]);
const VJ_TAKEOVER_SCREEN_IDS = new Set(["A1", "B1", "B2", "B3", "B4", "B5", "B6", "L1", "L2", "R1", "R2"]);

export function isModuleName(value: unknown): value is ModuleName {
  return typeof value === "string" && MODULE_NAMES.includes(value as ModuleName);
}

export function createDefaultState(now = Date.now()): PerformanceState {
  return {
    protocolVersion: "mixer.realtime.v1",
    performanceProtocolVersion: "performance.show.v1",
    updatedAt: now,
    show: {
      id: "show-main",
      name: "Live Performance",
      status: "standby",
      startedAt: null,
      positionMs: 0,
      bpm: 120,
      beat: 0,
      bar: 1
    },
    room: {
      id: "classroom-a",
      name: "Main Performance Room",
      mode: "live-performance"
    },
    modules: {
      audio: {
        status: "online",
        projectName: "Music Editor",
        transport: "stopped",
        masterLevel: 0.42,
        activeTab: "tab-1",
        activePreset: "Neon Loop",
        bpm: 120,
        activeSourceId: "mic-teacher",
        slots: [
          { id: "slot-1", name: "Beat", category: "beat", muted: false, level: 0.72 },
          { id: "slot-2", name: "Bass", category: "bass", muted: false, level: 0.58 },
          { id: "slot-3", name: "Melody", category: "melody", muted: false, level: 0.48 },
          { id: "slot-4", name: "FX", category: "effect", muted: false, level: 0.32 }
        ],
        fx: {
          compressor: 18,
          reverb: 8,
          delay: 0
        },
        arrangementSummary: null
      },
      visual: {
        status: "online",
        scene: "Cyber",
        preset: "Neon Pulse",
        colors: {
          base: "#00f3ff",
          secondary: "#bf00ff",
          accent: "#ffffff",
          background: "#030008"
        },
        fx: {
          bloomIntensity: 1.5,
          rgbSplitAmount: 0.005,
          distortion: 0,
          glitchActive: false
        },
        text: {
          value: "NEONPULSE",
          animation: "Cinematic",
          reactive: 1
        },
        audioDriveMode: "mic",
        fullscreen: false,
        visualMemories: []
      },
      interaction: createDefaultInteractionModule()
    },
    audioSources: {
      "mic-teacher": makeAudioSource("mic-teacher", "Teacher Mic", 0.45, false, true, now),
      "mic-student": makeAudioSource("mic-student", "Student Mic", 0.18, false, false, now),
      "line-media": makeAudioSource("line-media", "Media Feed", 0.3, false, false, now),
      "remote-guest": makeAudioSource("remote-guest", "Remote Guest", 0.12, true, false, now)
    },
    clients: {},
    commandLog: [],
    eventLog: []
  };
}

function createDefaultInteractionModule(): InteractionModuleState {
  const now = Date.now();
  return {
    status: "online",
    screenTopology: SCREEN_TOPOLOGY,
    screenRegistry: createDefaultScreenRegistry(),
    screenRoutes: createScreenRoutesForPreset("balanced", now),
    screenRoutePreset: "balanced",
    screenPresentation: {
      autoRedirect: true,
      showDebug: false,
      showMenu: false
    },
    screenId: "C2",
    role: "screen",
    overview: false,
    mode: "idle",
    intensity: 0.08,
    treeGrowth: 0,
    gestureActive: false,
    lastInteraction: null,
    screenPulse: null
  };
}

function makeAudioSource(
  sourceId: string,
  displayName: string,
  level: number,
  muted: boolean,
  speaking: boolean,
  timestamp: number
): AudioFrame {
  return {
    type: "mixer.audioFrame",
    sourceId,
    deviceId: "mixer-main",
    displayName,
    timestamp,
    level,
    rms: Math.max(0, level - 0.08),
    peak: Math.min(1, level + 0.16),
    gain: muted ? 0 : 0.72,
    muted,
    speaking,
    frequencyBands: DEFAULT_BANDS
  };
}

export function hydrateState(snapshot: unknown): PerformanceState {
  if (!snapshot || typeof snapshot !== "object") return createDefaultState();
  return normalizePerformanceState(mergePatch(createDefaultState() as unknown as JsonRecord, snapshot as JsonRecord) as unknown as PerformanceState);
}

export function normalizeAudioFrame(input: unknown): AudioFrame {
  if (!input || typeof input !== "object") {
    throw new Error("audioFrame must be an object");
  }

  const record = input as JsonRecord;
  if (!record.sourceId || typeof record.sourceId !== "string") {
    throw new Error("audioFrame.sourceId is required");
  }

  const level = clampUnit(record.level);
  return {
    type: "mixer.audioFrame",
    sourceId: record.sourceId,
    deviceId: String(record.deviceId || "mixer-main"),
    displayName: String(record.displayName || record.sourceId),
    timestamp: numberOrNow(record.timestamp),
    level,
    rms: clampUnit(record.rms, Math.max(0, level - 0.06)),
    peak: clampUnit(record.peak, Math.min(1, level + 0.12)),
    gain: clampUnit(record.gain, 0.72),
    muted: Boolean(record.muted),
    speaking: typeof record.speaking === "boolean" ? record.speaking : level > 0.22,
    frequencyBands: normalizeBands(record.frequencyBands)
  };
}

export function normalizeControlCommand(input: unknown): ControlCommand {
  if (!input || typeof input !== "object") {
    throw new Error("controlCommand must be an object");
  }

  const record = input as JsonRecord;
  if (!record.target || typeof record.target !== "string") {
    throw new Error("controlCommand.target is required");
  }
  if (!record.command || typeof record.command !== "string") {
    throw new Error("controlCommand.command is required");
  }

  const module = String(record.module || inferModule(record.command));
  if (!isModuleName(module) && !["show", "video", "guest"].includes(module)) {
    throw new Error("controlCommand.module must be audio, visual, interaction, show, video, or guest");
  }

  return {
    type: "control.command",
    id: String(record.id || crypto.randomUUID()),
    target: record.target,
    module: module as ControlCommand["module"],
    command: record.command,
    value: record.value,
    issuedBy: String(record.issuedBy || "api-client"),
    timestamp: numberOrNow(record.timestamp)
  };
}

function inferModule(command: string): ControlCommand["module"] {
  if (["setMute", "setGain", "setMasterLevel", "setPreset", "setActiveTab"].includes(command)) return "audio";
  if (["setScene", "setText", "setAudioDrive", "setFullscreen", "setColors", "setFx"].includes(command)) return "visual";
  if ([
    "setInteractionMode",
    "setMode",
    "setIntensity",
    "resetTree",
    "pulseScreen",
    "setScreen",
    "setScreenOwner",
    "setScreenRoutePreset",
    "setScreenAutoRedirect",
    "setScreenDebugVisible",
    "setScreenMenuVisible",
    "setScreenPresentation"
  ].includes(command)) return "interaction";
  if (["play", "pause", "reset", "setBpm", "seek"].includes(command)) return "show";
  if (command === "focusVideo") return "video";
  if (command === "setGuestOnStage") return "guest";
  return "show";
}

export class ShowStateStore {
  private state: PerformanceState;

  constructor(initialState: PerformanceState = createDefaultState()) {
    this.state = hydrateState(initialState);
  }

  getState(): PerformanceState {
    return this.state;
  }

  reset(source = "control"): PerformanceState {
    this.state = createDefaultState();
    this.appendEvent("show.reset", "show", source, "Show state reset", {});
    return this.state;
  }

  applyAudioFrame(frame: AudioFrame): PerformanceState {
    this.state.audioSources[frame.sourceId] = {
      ...(this.state.audioSources[frame.sourceId] || {}),
      ...frame
    };
    this.state.modules.audio.activeSourceId = frame.sourceId;
    this.state.modules.audio.masterLevel = frame.muted ? 0 : frame.level;
    this.touch();
    return this.state;
  }

  applyModulePatch(moduleName: ModuleName, patch: JsonRecord, source = "module"): PerformanceState {
    mergePatch(this.state.modules[moduleName] as unknown as JsonRecord, patch);
    if (moduleName === "audio" && typeof patch.masterLevel === "number") {
      this.state.modules.audio.masterLevel = clampUnit(patch.masterLevel, this.state.modules.audio.masterLevel);
    }
    if (moduleName === "audio" && typeof patch.bpm === "number") {
      this.state.show.bpm = positiveNumber(patch.bpm, this.state.show.bpm);
    }
    if (moduleName === "interaction") {
      this.state.modules.interaction.screenTopology = normalizeScreenTopology(this.state.modules.interaction.screenTopology);
      this.state.modules.interaction.screenRegistry = normalizeScreenRegistry(this.state.modules.interaction.screenRegistry);
      const patchedPreset = normalizeScreenRoutePreset(patch.screenRoutePreset);
      if (patchedPreset) {
        this.state.modules.interaction.screenRoutePreset = patchedPreset;
        this.state.modules.interaction.screenRoutes = createScreenRoutesForPreset(patchedPreset, Date.now());
      }
      this.state.modules.interaction.screenPresentation = normalizeScreenPresentation(this.state.modules.interaction.screenPresentation);
      this.state.modules.interaction.screenRoutes = normalizeScreenRoutes(
        this.state.modules.interaction.screenRoutes,
        this.state.modules.interaction.screenRoutePreset
      );
    }
    this.touch();
    if (moduleName !== "audio") {
      this.appendEvent("module.statePatch", moduleName, source, `${moduleName} state updated`, patch);
    }
    return this.state;
  }

  applyControlCommand(command: ControlCommand): PerformanceState {
    applyCommand(this.state, command);
    this.state.commandLog.unshift(command);
    this.state.commandLog = this.state.commandLog.slice(0, 80);
    this.touch();
    this.appendEvent("control.command", command.module, command.issuedBy, `${command.command} -> ${command.target}`, {
      id: command.id,
      value: command.value
    });
    return this.state;
  }

  registerClient(message: ClientHelloMessage, fallbackId: string): ClientInfo {
    const now = Date.now();
    const module = isModuleName(message.module) || message.module === "dashboard"
      ? message.module
      : "unknown";
    const client: ClientInfo = {
      id: message.clientId || fallbackId,
      module,
      role: String(message.role || "client"),
      status: "online",
      connectedAt: this.state.clients[message.clientId || fallbackId]?.connectedAt || now,
      lastSeen: now,
      latency: null,
      capabilities: Array.isArray(message.capabilities) ? message.capabilities.map(String) : []
    };
    this.state.clients[client.id] = client;
    this.touch();
    this.appendEvent("client.presence", client.module, client.id, `${client.id} connected`, client);
    return client;
  }

  touchClient(clientId: string, sentAt?: number): ClientInfo | null {
    const client = this.state.clients[clientId];
    if (!client) return null;
    const now = Date.now();
    client.lastSeen = now;
    client.status = "online";
    client.latency = Number.isFinite(sentAt) ? Math.max(0, now - Number(sentAt)) : client.latency;
    this.touch();
    return client;
  }

  removeClient(clientId: string): ClientInfo | null {
    const client = this.state.clients[clientId];
    if (!client) return null;
    delete this.state.clients[clientId];
    this.touch();
    this.appendEvent("client.presence", client.module, client.id, `${client.id} disconnected`, client);
    return { ...client, status: "offline", lastSeen: Date.now() };
  }

  appendEvent(type: string, module: string | undefined, source: string | undefined, message: string, payload?: unknown): EventLogItem {
    const event: EventLogItem = {
      id: crypto.randomUUID(),
      type,
      module,
      source,
      message,
      timestamp: Date.now(),
      payload
    };
    this.state.eventLog.unshift(event);
    this.state.eventLog = this.state.eventLog.slice(0, 160);
    return event;
  }

  private touch() {
    this.state.updatedAt = Date.now();
  }
}

function applyCommand(state: PerformanceState, command: ControlCommand) {
  const value = command.value;

  if (command.module === "show") {
    if (command.command === "play") {
      state.show.status = "running";
      state.show.startedAt = state.show.startedAt || Date.now();
      state.modules.audio.transport = "playing";
    }
    if (command.command === "pause") {
      state.show.status = "paused";
      state.modules.audio.transport = "paused";
    }
    if (command.command === "reset") {
      state.show.status = "standby";
      state.show.positionMs = 0;
      state.show.beat = 0;
      state.show.bar = 1;
      state.modules.audio.transport = "stopped";
    }
    if (command.command === "setBpm") {
      state.show.bpm = positiveNumber(value, state.show.bpm);
      state.modules.audio.bpm = state.show.bpm;
    }
    if (command.command === "seek") {
      state.show.positionMs = Math.max(0, Math.round(positiveNumber(value, state.show.positionMs)));
    }
  }

  if (command.module === "audio") {
    const source = state.audioSources[command.target];
    if (source && command.command === "setMute") {
      source.muted = Boolean(value);
      source.gain = source.muted ? 0 : Math.max(source.gain, 0.5);
    }
    if (source && command.command === "setGain") {
      source.gain = clampUnit(value, source.gain);
      source.muted = source.gain === 0;
    }
    if (command.command === "setMasterLevel") state.modules.audio.masterLevel = clampUnit(value, state.modules.audio.masterLevel);
    if (command.command === "setPreset") state.modules.audio.activePreset = String(value || command.target);
    if (command.command === "setActiveTab") state.modules.audio.activeTab = String(value || command.target);
  }

  if (command.module === "visual" || command.module === "video") {
    if (command.command === "focusVideo") {
      state.modules.visual.scene = String(value || command.target);
      state.modules.visual.preset = "Focused";
    }
    if (command.command === "setScene") state.modules.visual.scene = String(value || command.target);
    if (command.command === "setPreset") state.modules.visual.preset = String(value || command.target);
    if (command.command === "setText") state.modules.visual.text.value = String(value || "");
    if (command.command === "setAudioDrive" && ["mic", "music", "hybrid"].includes(String(value))) {
      state.modules.visual.audioDriveMode = String(value) as "mic" | "music" | "hybrid";
    }
    if (command.command === "setFullscreen") state.modules.visual.fullscreen = Boolean(value);
    if (command.command === "setColors" && isRecord(value)) mergePatch(state.modules.visual.colors as unknown as JsonRecord, value);
    if (command.command === "setFx" && isRecord(value)) mergePatch(state.modules.visual.fx as unknown as JsonRecord, value);
  }

  if (command.module === "interaction") {
    if (["setInteractionMode", "setMode"].includes(command.command)) {
      state.modules.interaction.mode = String(value || command.target) as InteractionModuleState["mode"];
    }
    if (command.command === "setIntensity") state.modules.interaction.intensity = clampUnit(value, state.modules.interaction.intensity);
    if (command.command === "resetTree") {
      state.modules.interaction.treeGrowth = 0;
      state.modules.interaction.gestureActive = false;
      state.modules.interaction.mode = "idle";
      state.modules.interaction.intensity = 0.08;
    }
    if (command.command === "pulseScreen") {
      state.modules.interaction.screenPulse = { source: String(value || command.target), timestamp: Date.now() };
    }
    if (command.command === "setScreen") {
      state.modules.interaction.screenId = String(value || command.target);
      state.modules.interaction.role = state.modules.interaction.screenId === "MASTER" ? "master" : "screen";
    }
    if (command.command === "setScreenOwner") {
      const screenId = String(command.target || "");
      const owner = normalizeScreenOwner(value);
      if (SCREEN_IDS.includes(screenId as (typeof SCREEN_IDS)[number]) && owner) {
        state.modules.interaction.screenRoutes[screenId] = makeScreenRoute(screenId, owner, Date.now(), "control");
        state.modules.interaction.screenRoutePreset = "balanced";
      }
    }
    if (command.command === "setScreenRoutePreset") {
      const preset = normalizeScreenRoutePreset(value || command.target);
      if (preset) {
        state.modules.interaction.screenRoutePreset = preset;
        state.modules.interaction.screenRoutes = createScreenRoutesForPreset(preset, Date.now());
      }
    }
    if (command.command === "setScreenAutoRedirect") {
      state.modules.interaction.screenPresentation.autoRedirect = Boolean(value);
    }
    if (command.command === "setScreenDebugVisible") {
      state.modules.interaction.screenPresentation.showDebug = Boolean(value);
    }
    if (command.command === "setScreenMenuVisible") {
      state.modules.interaction.screenPresentation.showMenu = Boolean(value);
    }
    if (command.command === "setScreenPresentation" && isRecord(value)) {
      state.modules.interaction.screenPresentation = normalizeScreenPresentation({
        ...state.modules.interaction.screenPresentation,
        ...value
      });
    }
  }

  if (command.module === "guest" && command.command === "setGuestOnStage") {
    state.show.status = Boolean(value) ? "running" : state.show.status;
  }
}

function normalizeBands(value: unknown) {
  if (!Array.isArray(value)) return DEFAULT_BANDS;
  return value.slice(0, 32).map((item) => clampUnit(item));
}

function normalizePerformanceState(state: PerformanceState): PerformanceState {
  state.modules.interaction.screenTopology = normalizeScreenTopology(state.modules.interaction.screenTopology);
  state.modules.interaction.screenRegistry = normalizeScreenRegistry(state.modules.interaction.screenRegistry);
  state.modules.interaction.screenRoutePreset = normalizeScreenRoutePreset(state.modules.interaction.screenRoutePreset) || "balanced";
  state.modules.interaction.screenPresentation = normalizeScreenPresentation(state.modules.interaction.screenPresentation);
  state.modules.interaction.screenRoutes = normalizeScreenRoutes(
    state.modules.interaction.screenRoutes,
    state.modules.interaction.screenRoutePreset
  );
  return state;
}

function normalizeScreenPresentation(value: unknown): InteractionModuleState["screenPresentation"] {
  const record = isRecord(value) ? value : {};
  return {
    autoRedirect: typeof record.autoRedirect === "boolean" ? record.autoRedirect : true,
    showDebug: typeof record.showDebug === "boolean" ? record.showDebug : false,
    showMenu: typeof record.showMenu === "boolean" ? record.showMenu : false
  };
}

function createDefaultScreenRegistry() {
  return SCREEN_IDS.map((id, index) => ({
    id,
    label: `Screen ${id}`,
    enabled: true,
    physicalIndex: index + 1
  }));
}

function createScreenRoutesForPreset(preset: ScreenRoutePreset, now: number): Record<string, ScreenRouteEntry> {
  const routes: Record<string, ScreenRouteEntry> = {};
  for (const screenId of SCREEN_IDS) {
    const owner = ownerForPreset(screenId, preset);
    routes[screenId] = makeScreenRoute(screenId, owner, now, "preset");
  }
  return routes;
}

function ownerForPreset(screenId: string, preset: ScreenRoutePreset): ScreenOwner {
  if (preset === "baofa_takeover") return "baofa";
  if (preset === "vj_takeover") return VJ_TAKEOVER_SCREEN_IDS.has(screenId) ? "vj" : "baofa";
  return VJ_SCREEN_IDS.has(screenId) ? "vj" : "baofa";
}

function makeScreenRoute(screenId: string, owner: ScreenOwner, updatedAt: number, source?: string): ScreenRouteEntry {
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

function normalizeScreenRegistry(value: unknown) {
  if (!Array.isArray(value)) return createDefaultScreenRegistry();
  const byId = new Map<string, unknown>(value.map((item) => {
    const record = isRecord(item) ? item : {};
    return [String(record.id || ""), record];
  }));
  return SCREEN_IDS.map((id, index) => {
    const record = isRecord(byId.get(id)) ? byId.get(id) as JsonRecord : {};
    return {
      id,
      label: String(record.label || `Screen ${id}`),
      enabled: typeof record.enabled === "boolean" ? record.enabled : true,
      physicalIndex: Math.max(1, Math.round(positiveNumber(record.physicalIndex, index + 1)))
    };
  });
}

function normalizeScreenRoutes(value: unknown, preset: ScreenRoutePreset) {
  const defaults = createScreenRoutesForPreset(preset, Date.now());
  if (!isRecord(value)) return defaults;

  for (const screenId of SCREEN_IDS) {
    const existing = value[screenId];
    if (!isRecord(existing)) continue;
    const owner = normalizeScreenOwner(existing.owner) || defaults[screenId].owner;
    defaults[screenId] = {
      ...defaults[screenId],
      ...existing,
      screenId,
      owner,
      url: typeof existing.url === "string" || existing.url === null
        ? existing.url
        : makeScreenRoute(screenId, owner, defaults[screenId].updatedAt).url,
      updatedAt: positiveNumber(existing.updatedAt, defaults[screenId].updatedAt)
    };
  }
  return defaults;
}

function normalizeScreenOwner(value: unknown): ScreenOwner | null {
  return ["vj", "baofa", "off", "diagnostic"].includes(String(value)) ? String(value) as ScreenOwner : null;
}

function normalizeScreenRoutePreset(value: unknown): ScreenRoutePreset | null {
  return ["balanced", "vj_takeover", "baofa_takeover"].includes(String(value)) ? String(value) as ScreenRoutePreset : null;
}

function normalizeScreenTopology(value: unknown): string[][] {
  if (!Array.isArray(value)) return SCREEN_TOPOLOGY;
  if (value.every((row) => Array.isArray(row))) {
    const rows = value
      .map((row) => row.map((screenId) => String(screenId || "")))
      .filter((row) => row.length > 0);
    return rows.length > 0 ? rows : SCREEN_TOPOLOGY;
  }
  if (value.every((screenId) => typeof screenId === "string")) {
    const screens = value.map((screenId) => screenId.trim()).filter(Boolean);
    if (screens.length === 0) return SCREEN_TOPOLOGY;
    const rows: string[][] = [];
    for (let index = 0; index < screens.length; index += 6) {
      rows.push(screens.slice(index, index + 6));
    }
    return rows;
  }
  return SCREEN_TOPOLOGY;
}

function clampUnit(value: unknown, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function positiveNumber(value: unknown, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, number);
}

function numberOrNow(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergePatch<T extends JsonRecord>(target: T, patch: JsonRecord): T {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isRecord(value) && isRecord(target[key])) {
      mergePatch(target[key] as JsonRecord, value);
    } else {
      target[key as keyof T] = value as T[keyof T];
    }
  }
  return target;
}
