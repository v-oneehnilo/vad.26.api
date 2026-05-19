export const MODULE_NAMES = ["audio", "visual", "interaction"] as const;

export type ModuleName = (typeof MODULE_NAMES)[number];
export type ModuleStatus = "offline" | "standby" | "online" | "live" | "error";
export type ShowStatus = "standby" | "running" | "paused" | "ended";
export type JsonRecord = Record<string, unknown>;

export interface AudioFrame {
  type: "mixer.audioFrame";
  sourceId: string;
  deviceId: string;
  displayName: string;
  timestamp: number;
  level: number;
  rms: number;
  peak: number;
  gain: number;
  muted: boolean;
  speaking: boolean;
  frequencyBands: number[];
}

export interface ControlCommand {
  type: "control.command";
  id: string;
  target: string;
  module: ModuleName | "show" | "video" | "guest";
  command: string;
  value?: unknown;
  issuedBy: string;
  timestamp: number;
}

export interface ShowState {
  id: string;
  name: string;
  status: ShowStatus;
  startedAt: number | null;
  positionMs: number;
  bpm: number;
  beat: number;
  bar: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  z: number;
  timestamp: number;
}

export interface AudioModuleState {
  status: ModuleStatus;
  projectName: string;
  transport: "stopped" | "playing" | "paused";
  masterLevel: number;
  activeTab: string;
  activePreset: string;
  bpm: number;
  activeSourceId: string;
  slots: Array<{
    id: string;
    name: string;
    category: string;
    muted: boolean;
    level: number;
  }>;
  fx: JsonRecord;
  arrangementSummary: null | {
    fileName?: string;
    tabCount?: number;
    slotCount?: number;
    exportedAt?: number;
  };
}

export interface VisualModuleState {
  status: ModuleStatus;
  scene: string;
  preset: string;
  colors: {
    base: string;
    secondary: string;
    accent: string;
    background: string;
  };
  fx: {
    bloomIntensity: number;
    rgbSplitAmount: number;
    distortion: number;
    glitchActive: boolean;
  };
  text: {
    value: string;
    animation: string;
    reactive: number;
  };
  audioDriveMode: "mic" | "music" | "hybrid";
  fullscreen: boolean;
  visualMemories: Array<{ id: string; name: string; scene: string }>;
}

export interface InteractionModuleState {
  status: ModuleStatus;
  screenTopology: string[][];
  screenId: string;
  role: "screen" | "master";
  overview: boolean;
  mode: "idle" | "interaction" | "flow" | "climax";
  intensity: number;
  treeGrowth: number;
  gestureActive: boolean;
  lastInteraction: ScreenPoint | null;
  screenPulse: null | { source: string; timestamp: number };
}

export interface ClientInfo {
  id: string;
  module: ModuleName | "dashboard" | "unknown";
  role: string;
  status: "online" | "offline";
  connectedAt: number;
  lastSeen: number;
  latency: number | null;
  capabilities: string[];
}

export interface EventLogItem {
  id: string;
  type: string;
  module?: string;
  source?: string;
  message: string;
  timestamp: number;
  payload?: unknown;
}

export interface PerformanceState {
  protocolVersion: "mixer.realtime.v1";
  performanceProtocolVersion: "performance.show.v1";
  updatedAt: number;
  show: ShowState;
  room: {
    id: string;
    name: string;
    mode: string;
  };
  modules: {
    audio: AudioModuleState;
    visual: VisualModuleState;
    interaction: InteractionModuleState;
  };
  audioSources: Record<string, AudioFrame>;
  clients: Record<string, ClientInfo>;
  commandLog: ControlCommand[];
  eventLog: EventLogItem[];
}

export interface ClientHelloMessage {
  type: "client.hello";
  clientId?: string;
  module?: string;
  role?: string;
  capabilities?: string[];
  token?: string;
}

export interface ModuleStatePatchMessage {
  type: "module.statePatch";
  module: ModuleName;
  patch?: JsonRecord;
  state?: JsonRecord;
  source?: string;
  token?: string;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  clientId?: string;
  sentAt?: number;
}
