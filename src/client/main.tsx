import React from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Aperture,
  AudioLines,
  CircleDot,
  Database,
  Gauge,
  Grid3X3,
  ListChecks,
  MonitorCog,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Save,
  Send,
  SlidersHorizontal,
  Type,
  Zap
} from "lucide-react";
import type { ControlCommand, ModuleName, PerformanceState } from "../types";
import { createFirebaseDashboardClient, shouldUseFirebaseRealtime } from "./firebaseShowControl";
import "./styles.css";

type ConnectionState = "connecting" | "connected" | "offline";

type ServerMessage =
  | { type: "state.snapshot"; state: PerformanceState }
  | { type: "state.patch"; state: PerformanceState; module: ModuleName; patch: Record<string, unknown> }
  | { type: "control.ack"; ok: boolean; command: ControlCommand }
  | { type: "client.presence"; state?: PerformanceState }
  | { type: "error"; error: string }
  | { type: string; [key: string]: unknown };

const moduleLabels: Record<ModuleName, { label: string; icon: React.ReactNode; accent: string }> = {
  audio: { label: "Audio", icon: <AudioLines size={17} />, accent: "var(--audio)" },
  visual: { label: "Visual", icon: <Aperture size={17} />, accent: "var(--visual)" },
  interaction: { label: "Interaction", icon: <Grid3X3 size={17} />, accent: "var(--interaction)" }
};

const interactionModes = ["idle", "interaction", "flow", "climax"];
const visualScenes = ["Cyber", "Liquid", "Topology", "Pulse", "Void", "Dumbar"];
const audioPresets = ["Neon Loop", "Warehouse", "Dream Pop", "Break Lab", "EDM Festival", "Echo Bass"];

function App() {
  const [snapshot, setSnapshot] = React.useState<PerformanceState | null>(null);
  const [connection, setConnection] = React.useState<ConnectionState>("connecting");
  const [token, setToken] = React.useState(() => window.localStorage.getItem("vad-control-token") || "");
  const [lastAck, setLastAck] = React.useState("Waiting for control activity");
  const [manualText, setManualText] = React.useState("NEONPULSE");
  const firebaseClientRef = React.useRef<ReturnType<typeof createFirebaseDashboardClient> | null>(null);

  React.useEffect(() => {
    window.localStorage.setItem("vad-control-token", token);
  }, [token]);

  React.useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let firebaseClient: ReturnType<typeof createFirebaseDashboardClient> | null = null;

    async function boot() {
      try {
        const state = await fetchJson<PerformanceState>("/api/state");
        if (!closed) setSnapshot(state);
        if (shouldUseFirebaseRealtime()) {
          firebaseClient = createFirebaseDashboardClient({
            initialState: state,
            token,
            onState: (nextState) => {
              if (!closed) setSnapshot(nextState);
            },
            onStatus: (status) => {
              if (!closed) setConnection(status);
            },
            onAck: (message) => {
              if (!closed) setLastAck(message);
            },
            onError: (message) => {
              if (!closed) setLastAck(message);
            }
          });
          firebaseClientRef.current = firebaseClient;
          return;
        }
      } catch {
        if (!closed) setConnection("offline");
      }
      connect();
    }

    function connect() {
      if (closed) return;
      setConnection("connecting");
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
      socket.addEventListener("open", () => {
        setConnection("connected");
        socket?.send(JSON.stringify({
          type: "client.hello",
          clientId: "dashboard-main",
          module: "dashboard",
          role: "control-room",
          capabilities: ["state.read", "control.command", "dashboard"]
        }));
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data) as ServerMessage;
        if (isStateMessage(message)) setSnapshot(message.state);
        if (isControlAck(message)) setLastAck(`${message.command.command} accepted for ${message.command.target}`);
        if (isErrorMessage(message)) setLastAck(message.error);
      });
      socket.addEventListener("close", () => {
        if (closed) return;
        setConnection("offline");
        reconnectTimer = window.setTimeout(connect, 1200);
      });
    }

    void boot();
    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
      firebaseClientRef.current = null;
      void firebaseClient?.close();
    };
  }, [token]);

  const postJson = React.useCallback(async <T,>(url: string, body: unknown): Promise<T> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["x-control-token"] = token;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
    return payload as T;
  }, [token]);

  const sendControl = React.useCallback(async (
    module: ControlCommand["module"],
    command: string,
    target: string,
    value?: unknown
  ) => {
    try {
      const payload: Omit<ControlCommand, "timestamp"> = {
        type: "control.command",
        id: crypto.randomUUID(),
        module,
        target,
        command,
        value,
        issuedBy: "dashboard-main"
      };
      if (shouldUseFirebaseRealtime() && firebaseClientRef.current) {
        const commandResult = await firebaseClientRef.current.sendControl(payload);
        setLastAck(`${commandResult.command} sent for ${commandResult.target}`);
        return;
      }
      const result = await postJson<{ state: PerformanceState; command: ControlCommand }>("/api/control", payload);
      setSnapshot(result.state);
      setLastAck(`${result.command.command} accepted for ${result.command.target}`);
    } catch (error) {
      setLastAck(error instanceof Error ? error.message : String(error));
    }
  }, [postJson]);

  const saveSnapshot = React.useCallback(async () => {
    try {
      if (shouldUseFirebaseRealtime() && firebaseClientRef.current) {
        await firebaseClientRef.current.saveSnapshot();
        return;
      }
      const result = await postJson<{ state: PerformanceState }>("/api/show/snapshot", {});
      setSnapshot(result.state);
      setLastAck("Snapshot saved");
    } catch (error) {
      setLastAck(error instanceof Error ? error.message : String(error));
    }
  }, [postJson]);

  const resetShow = React.useCallback(async () => {
    try {
      if (shouldUseFirebaseRealtime() && firebaseClientRef.current) {
        await firebaseClientRef.current.resetShow();
        return;
      }
      const result = await postJson<{ state: PerformanceState }>("/api/show/reset", {});
      setSnapshot(result.state);
      setLastAck("Show reset");
    } catch (error) {
      setLastAck(error instanceof Error ? error.message : String(error));
    }
  }, [postJson]);

  if (!snapshot) {
    return (
      <main className="loading-screen">
        <Radio size={22} />
        <span>Connecting to VAD show control</span>
      </main>
    );
  }

  const show = snapshot.show;
  const clients = Object.values(snapshot.clients);
  const audioSources = Object.values(snapshot.audioSources).sort((a, b) => b.level - a.level);
  const activeSource = snapshot.audioSources[snapshot.modules.audio.activeSourceId] || audioSources[0];
  const screenTopology = normalizeScreenTopology(snapshot.modules.interaction.screenTopology);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">V</div>
          <div>
            <strong>VAD Control</strong>
            <span>Performance backend</span>
          </div>
        </div>

        <div className="connection-card">
          <div className={`connection-dot ${connection}`} />
          <div>
            <strong>{connection}</strong>
            <span>{clients.length} clients online</span>
          </div>
        </div>

        <nav className="module-nav" aria-label="Modules">
          {(Object.keys(moduleLabels) as ModuleName[]).map((moduleName) => (
            <a key={moduleName} href={`#${moduleName}`} style={{ "--accent": moduleLabels[moduleName].accent } as React.CSSProperties}>
              {moduleLabels[moduleName].icon}
              <span>{moduleLabels[moduleName].label}</span>
              <i>{snapshot.modules[moduleName].status}</i>
            </a>
          ))}
        </nav>

        <label className="token-field">
          <span>CONTROL_TOKEN</span>
          <input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="optional"
            type="password"
          />
        </label>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p>{snapshot.room.name}</p>
            <h1>{show.name}</h1>
          </div>
          <div className="transport">
            <StatusPill status={show.status} />
            <button type="button" onClick={() => sendControl("show", "play", show.id, true)}><Play size={16} /> Play</button>
            <button type="button" onClick={() => sendControl("show", "pause", show.id, false)}><Pause size={16} /> Pause</button>
            <button type="button" onClick={resetShow}><RotateCcw size={16} /> Reset</button>
            <button type="button" onClick={saveSnapshot}><Save size={16} /> Save</button>
          </div>
        </header>

        <section className="metrics-grid">
          <Metric label="BPM" value={show.bpm} icon={<Gauge size={18} />} />
          <Metric label="Position" value={formatMs(show.positionMs)} icon={<Activity size={18} />} />
          <Metric label="Master" value={`${Math.round(snapshot.modules.audio.masterLevel * 100)}%`} icon={<SlidersHorizontal size={18} />} />
          <Metric label="Last Ack" value={lastAck} icon={<CircleDot size={18} />} wide />
        </section>

        <section className="main-grid">
          <Panel id="audio" title="Audio Matrix" icon={<AudioLines size={18} />}>
            <div className="active-source">
              <div>
                <span>Active source</span>
                <strong>{activeSource?.displayName || "No source"}</strong>
              </div>
              <div className="meter">
                <i style={{ width: `${(activeSource?.level || 0) * 100}%` }} />
              </div>
            </div>

            <div className="source-list">
              {audioSources.map((source) => (
                <article key={source.sourceId} className={source.muted ? "source-row muted" : "source-row"}>
                  <button type="button" onClick={() => sendControl("audio", "setMute", source.sourceId, !source.muted)}>
                    {source.muted ? "Unmute" : "Mute"}
                  </button>
                  <div>
                    <strong>{source.displayName}</strong>
                    <span>{source.sourceId} · {source.speaking && !source.muted ? "speaking" : "idle"}</span>
                  </div>
                  <small>{Math.round(source.level * 100)}%</small>
                </article>
              ))}
            </div>

            <div className="button-row">
              {audioPresets.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={snapshot.modules.audio.activePreset === preset ? "selected" : ""}
                  onClick={() => sendControl("audio", "setPreset", "audio-preset", preset)}
                >
                  {preset}
                </button>
              ))}
            </div>
          </Panel>

          <Panel id="visual" title="Visual Control" icon={<Aperture size={18} />}>
            <div className="scene-readout">
              <div>
                <span>Scene</span>
                <strong>{snapshot.modules.visual.scene}</strong>
              </div>
              <div>
                <span>Preset</span>
                <strong>{snapshot.modules.visual.preset}</strong>
              </div>
              <div>
                <span>Drive</span>
                <strong>{snapshot.modules.visual.audioDriveMode}</strong>
              </div>
            </div>

            <div className="swatches">
              {Object.entries(snapshot.modules.visual.colors).map(([name, color]) => (
                <span key={name} title={name} style={{ background: color }} />
              ))}
            </div>

            <div className="button-row">
              {visualScenes.map((scene) => (
                <button
                  key={scene}
                  type="button"
                  className={snapshot.modules.visual.scene === scene ? "selected" : ""}
                  onClick={() => sendControl("visual", "setScene", "visual-main", scene)}
                >
                  {scene}
                </button>
              ))}
            </div>

            <form className="inline-form" onSubmit={(event) => {
              event.preventDefault();
              void sendControl("visual", "setText", "visual-text", manualText);
            }}>
              <Type size={16} />
              <input value={manualText} onChange={(event) => setManualText(event.target.value)} />
              <button type="submit"><Send size={15} /> Send</button>
            </form>
          </Panel>

          <Panel id="interaction" title="Multi-screen Interaction" icon={<MonitorCog size={18} />}>
            <div className="screen-grid">
              <button
                type="button"
                className={snapshot.modules.interaction.screenId === "MASTER" ? "selected master-screen" : "master-screen"}
                onClick={() => sendControl("interaction", "setScreen", "MASTER", "MASTER")}
              >
                MASTER
              </button>
              {screenTopology.flatMap((row, rowIndex) =>
                row.map((screenId, index) => screenId ? (
                  <button
                    key={screenId}
                    type="button"
                    className={snapshot.modules.interaction.screenId === screenId ? "selected" : ""}
                    style={{ gridColumn: index + 1, gridRow: rowIndex + 2 }}
                    onClick={() => sendControl("interaction", "setScreen", screenId, screenId)}
                  >
                    {screenId}
                  </button>
                ) : (
                  <span key={`empty-${rowIndex}-${index}`} style={{ gridColumn: index + 1, gridRow: rowIndex + 2 }} />
                ))
              )}
            </div>

            <div className="interaction-readout">
              <span>Intensity {Math.round(snapshot.modules.interaction.intensity * 100)}%</span>
              <span>Growth {Math.round(snapshot.modules.interaction.treeGrowth * 100)}%</span>
              <span>{snapshot.modules.interaction.gestureActive ? "gesture active" : "gesture idle"}</span>
            </div>

            <div className="button-row">
              {interactionModes.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={snapshot.modules.interaction.mode === mode ? "selected" : ""}
                  onClick={() => sendControl("interaction", "setMode", "interaction-mode", mode)}
                >
                  {mode}
                </button>
              ))}
              <button type="button" onClick={() => sendControl("interaction", "pulseScreen", snapshot.modules.interaction.screenId, snapshot.modules.interaction.screenId)}>
                <Zap size={15} /> Pulse
              </button>
              <button type="button" onClick={() => sendControl("interaction", "resetTree", "tree", true)}>
                Reset tree
              </button>
            </div>
          </Panel>

          <Panel title="Event Log" icon={<ListChecks size={18} />} compact>
            <div className="event-list">
              {snapshot.eventLog.slice(0, 12).map((event) => (
                <article key={event.id}>
                  <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
                  <strong>{event.type}</strong>
                  <p>{event.message}</p>
                </article>
              ))}
            </div>
          </Panel>

          <Panel title="Connected Clients" icon={<Database size={18} />} compact>
            <div className="client-list">
              {clients.length === 0 && <p className="empty">No module clients have announced presence.</p>}
              {clients.map((client) => (
                <article key={client.id}>
                  <strong>{client.id}</strong>
                  <span>{client.module} · {client.role}</span>
                  <small>{new Date(client.lastSeen).toLocaleTimeString()}</small>
                </article>
              ))}
            </div>
          </Panel>
        </section>
      </section>
    </main>
  );
}

function Panel({
  id,
  title,
  icon,
  compact,
  children
}: {
  id?: string;
  title: string;
  icon: React.ReactNode;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={compact ? "panel compact" : "panel"}>
      <div className="panel-heading">
        <h2>{icon}{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value, icon, wide }: { label: string; value: React.ReactNode; icon: React.ReactNode; wide?: boolean }) {
  return (
    <article className={wide ? "metric wide" : "metric"}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill ${status}`}>{status}</span>;
}

function isStateMessage(message: ServerMessage): message is Extract<ServerMessage, { type: "state.snapshot" | "state.patch" }> {
  return message.type === "state.snapshot" || message.type === "state.patch";
}

function isControlAck(message: ServerMessage): message is Extract<ServerMessage, { type: "control.ack" }> {
  return message.type === "control.ack";
}

function isErrorMessage(message: ServerMessage): message is Extract<ServerMessage, { type: "error" }> {
  return message.type === "error";
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

function formatMs(value: number) {
  const minutes = Math.floor(value / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function normalizeScreenTopology(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  if (value.every((row) => Array.isArray(row))) {
    return value.map((row) => row.map((screenId) => String(screenId || "")));
  }
  if (value.every((screenId) => typeof screenId === "string")) {
    const screens = value.map((screenId) => screenId.trim()).filter(Boolean);
    const rows: string[][] = [];
    for (let index = 0; index < screens.length; index += 6) {
      rows.push(screens.slice(index, index + 6));
    }
    return rows;
  }
  return [];
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
