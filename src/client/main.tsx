import React from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Aperture,
  AudioLines,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Database,
  Gauge,
  Grid3X3,
  ListChecks,
  Lock,
  MonitorCog,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Save,
  Send,
  SlidersHorizontal,
  Sparkles,
  Type,
  Unlock,
  Zap
} from "lucide-react";
import type { ControlCommand, ModuleName, PerformanceState, ScreenOwner, ScreenRoutePreset } from "../types";
import { createFirebaseDashboardClient, shouldUseFirebaseRealtime } from "./firebaseShowControl";
import "./styles.css";

type ConnectionState = "connecting" | "connected" | "offline";
type ScreenSelectionMode = "solid" | "dashed" | "box";
type SequenceStep = "1/16" | "1/8" | "1/4" | "1/2" | "1";
type SequenceGroup = { order: number; screenIds: string[] };
type DragBox = { startX: number; startY: number; currentX: number; currentY: number };

const env = import.meta.env;
const defaultControlToken = env.VITE_CONTROL_TOKEN || "";

type ServerMessage =
  | { type: "state.snapshot"; state: PerformanceState }
  | { type: "state.patch"; state?: PerformanceState; module: ModuleName; patch: Record<string, unknown>; updatedAt?: number }
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
const screenSelectionModes: Array<{ id: ScreenSelectionMode; label: string }> = [
  { id: "solid", label: "实线点选" },
  { id: "dashed", label: "虚线点选" },
  { id: "box", label: "框选" }
];
const sequenceSteps: SequenceStep[] = ["1/16", "1/8", "1/4", "1/2", "1"];
const screenRoutePresets: Array<{ value: ScreenRoutePreset; label: string }> = [
  { value: "balanced", label: "Balanced" },
  { value: "vj_takeover", label: "VJ Takeover" },
  { value: "baofa_takeover", label: "Baofa Takeover" }
];
const screenOwners: Array<{ value: ScreenOwner; label: string }> = [
  { value: "vj", label: "VJ" },
  { value: "baofa", label: "Baofa" },
  { value: "off", label: "Off" },
  { value: "diagnostic", label: "Diag" }
];

type ScreenLayoutItem = {
  id: string;
  col: number;
  row: number;
  width?: number;
  height?: number;
  rotate?: number;
};

const stageBounds = { width: 11, height: 6.4 };
const screenLayoutItems: ScreenLayoutItem[] = [
  { id: "A1", col: 5.5, row: 0.7, width: 3.9, height: 1.05 },
  { id: "B1", col: 2.9, row: 1.75 },
  { id: "B2", col: 3.95, row: 1.75 },
  { id: "B3", col: 5.0, row: 1.75 },
  { id: "B4", col: 6.05, row: 1.75 },
  { id: "B5", col: 7.1, row: 1.75 },
  { id: "B6", col: 8.15, row: 1.75 },
  { id: "C1", col: 1.75, row: 2.55, rotate: -14 },
  { id: "C2", col: 2.55, row: 2.35, rotate: -4 },
  { id: "C3", col: 8.45, row: 2.35, rotate: 4 },
  { id: "C4", col: 9.25, row: 2.55, rotate: 14 },
  { id: "D1", col: 4.2, row: 3.35 },
  { id: "D2", col: 5.5, row: 3.15 },
  { id: "D3", col: 6.8, row: 3.35 },
  { id: "E1", col: 5.5, row: 4.35, width: 1.15 },
  { id: "F1", col: 5.5, row: 5.55, width: 1.2 },
  { id: "L1", col: 0.95, row: 4.2, height: 0.82 },
  { id: "L2", col: 0.95, row: 5.4, height: 0.82 },
  { id: "R1", col: 10.05, row: 4.2, height: 0.82 },
  { id: "R2", col: 10.05, row: 5.4, height: 0.82 }
];
const screenLayoutOrder = screenLayoutItems.map((screen) => screen.id);

function Root() {
  const screenId = getScreenIdFromPath();
  if (screenId) return <ScreenGateway screenId={screenId} />;
  return <App />;
}

function App() {
  const [snapshot, setSnapshot] = React.useState<PerformanceState | null>(null);
  const [connection, setConnection] = React.useState<ConnectionState>("connecting");
  const [token, setToken] = React.useState(() => window.localStorage.getItem("vad-control-token") || defaultControlToken);
  const [lastAck, setLastAck] = React.useState("Waiting for control activity");
  const [manualText, setManualText] = React.useState("NEONPULSE");
  const [screenSelectionMode, setScreenSelectionMode] = React.useState<ScreenSelectionMode>("solid");
  const [sequenceStep, setSequenceStep] = React.useState<SequenceStep>("1/4");
  const [sequenceGroups, setSequenceGroups] = React.useState<SequenceGroup[]>([]);
  const [dragBox, setDragBox] = React.useState<DragBox | null>(null);
  const firebaseClientRef = React.useRef<ReturnType<typeof createFirebaseDashboardClient> | null>(null);
  const screenGridRef = React.useRef<HTMLDivElement | null>(null);

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
        if (isStateSnapshot(message)) setSnapshot(message.state);
        if (isStatePatch(message)) {
          setSnapshot((current) => message.state || (current ? applyStatePatch(current, message) : current));
        }
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

  const sequenceOrderByScreen = React.useMemo(() => {
    const orders = new Map<string, number>();
    sequenceGroups.forEach((group) => {
      group.screenIds.forEach((screenId) => orders.set(screenId, group.order));
    });
    return orders;
  }, [sequenceGroups]);

  const addSequenceGroup = React.useCallback((screenIds: string[]) => {
    const uniqueScreenIds = Array.from(new Set(screenIds.filter((screenId) => screenLayoutOrder.includes(screenId))));
    if (uniqueScreenIds.length === 0) return;
    setSequenceGroups((current) => {
      const alreadySelected = new Set(current.flatMap((group) => group.screenIds));
      const nextScreenIds = uniqueScreenIds.filter((screenId) => !alreadySelected.has(screenId));
      if (nextScreenIds.length === 0) return current;
      return [...current, { order: current.length + 1, screenIds: nextScreenIds }];
    });
  }, []);

  const clearSequence = React.useCallback(() => {
    setSequenceGroups([]);
    setDragBox(null);
  }, []);

  const handleScreenSelect = React.useCallback((screenId: string) => {
    if (screenSelectionMode === "solid") {
      clearSequence();
      void sendControl("interaction", "setScreen", screenId, screenId);
      return;
    }
    if (screenSelectionMode === "dashed") {
      addSequenceGroup([screenId]);
    }
  }, [addSequenceGroup, clearSequence, screenSelectionMode, sendControl]);

  const handleBoxPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (screenSelectionMode !== "box" || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const box = clampPoint(event.clientX - rect.left, event.clientY - rect.top, rect);
    setDragBox(box);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [screenSelectionMode]);

  const handleBoxPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragBox || screenSelectionMode !== "box") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = clampPoint(event.clientX - rect.left, event.clientY - rect.top, rect);
    setDragBox((current) => current ? { ...current, currentX: point.currentX, currentY: point.currentY } : current);
  }, [dragBox, screenSelectionMode]);

  const handleBoxPointerUp = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragBox || screenSelectionMode !== "box" || !screenGridRef.current) return;
    const gridRect = screenGridRef.current.getBoundingClientRect();
    const selectionRect = normalizeRect(dragBox);
    const selectedScreenIds = Array.from(screenGridRef.current.querySelectorAll<HTMLButtonElement>("[data-screen-id]"))
      .filter((button) => {
        const buttonRect = button.getBoundingClientRect();
        return rectsIntersect(selectionRect, {
          left: buttonRect.left - gridRect.left,
          right: buttonRect.right - gridRect.left,
          top: buttonRect.top - gridRect.top,
          bottom: buttonRect.bottom - gridRect.top
        });
      })
      .map((button) => button.dataset.screenId)
      .filter((screenId): screenId is string => Boolean(screenId));
    addSequenceGroup(selectedScreenIds);
    setDragBox(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, [addSequenceGroup, dragBox, screenSelectionMode]);

  const pulseSelectedScreens = React.useCallback(async () => {
    if (sequenceGroups.length === 0 && snapshot) {
      await sendControl("interaction", "pulseScreen", snapshot.modules.interaction.screenId, snapshot.modules.interaction.screenId);
      return;
    }

    const groups = [...sequenceGroups].sort((a, b) => a.order - b.order);
    const sequenceDelay = stepDurationMs(sequenceStep, snapshot?.show.bpm || 120);
    for (const group of groups) {
      await Promise.all(group.screenIds.map((screenId) => sendControl("interaction", "pulseScreen", screenId, screenId)));
      if (groups.length > 1) await wait(sequenceDelay);
    }
  }, [sendControl, sequenceGroups, sequenceStep, snapshot]);

  const triggerInteractionMode = React.useCallback(async (mode: string) => {
    if (sequenceGroups.length === 0) {
      await sendControl("interaction", "setMode", "interaction-mode", mode);
      return;
    }

    const groups = [...sequenceGroups].sort((a, b) => a.order - b.order);
    const sequenceDelay = stepDurationMs(sequenceStep, snapshot?.show.bpm || 120);
    for (const group of groups) {
      await Promise.all(group.screenIds.map((screenId) => sendControl("interaction", "setMode", screenId, mode)));
      if (groups.length > 1) await wait(sequenceDelay);
    }
  }, [sendControl, sequenceGroups, sequenceStep, snapshot?.show.bpm]);

  if (!snapshot) {
    return (
      <main className="loading-screen">
        <Radio size={22} />
        <span>Connecting to VAD show control</span>
      </main>
    );
  }

  const show = snapshot.show;
  const operationLock = snapshot.operationLock;
  const lockedModules = operationLock.lockedModules || [];
  const clients = Object.values(snapshot.clients);
  const audioSources = Object.values(snapshot.audioSources).sort((a, b) => b.level - a.level);
  const activeSource = snapshot.audioSources[snapshot.modules.audio.activeSourceId] || audioSources[0];
  const screenTopology = normalizeScreenTopology(snapshot.modules.interaction.screenTopology);
  const screenRoutes = snapshot.modules.interaction.screenRoutes || {};
  const screenPresentation = snapshot.modules.interaction.screenPresentation || {
    autoRedirect: true,
    showDebug: false,
    showMenu: false
  };

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
            <div key={moduleName} className="module-nav-item" style={{ "--accent": moduleLabels[moduleName].accent } as React.CSSProperties}>
              <a href={`#${moduleName}`}>
                {moduleLabels[moduleName].icon}
                <span>{moduleLabels[moduleName].label}</span>
                <i>{snapshot.modules[moduleName].status}</i>
              </a>
              <button
                type="button"
                className={lockedModules.includes(moduleName) ? "module-lock-button locked" : "module-lock-button"}
                title={lockedModules.includes(moduleName) ? `Unlock ${moduleLabels[moduleName].label}` : `Lock ${moduleLabels[moduleName].label}`}
                aria-label={lockedModules.includes(moduleName) ? `Unlock ${moduleLabels[moduleName].label}` : `Lock ${moduleLabels[moduleName].label}`}
                onClick={() => sendControl("interaction", "setOperationLock", moduleName, {
                  module: moduleName,
                  locked: !lockedModules.includes(moduleName)
                })}
              >
                {lockedModules.includes(moduleName) ? <Lock size={16} /> : <Unlock size={16} />}
              </button>
            </div>
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
              <button
                type="button"
                className={snapshot.modules.visual.fullscreen ? "selected" : ""}
                onClick={() => sendControl("visual", "setFullscreen", "visual-fullscreen", !snapshot.modules.visual.fullscreen)}
              >
                Fullscreen
              </button>
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
            <div className="route-presets" aria-label="Screen route presets">
              {screenRoutePresets.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  className={snapshot.modules.interaction.screenRoutePreset === preset.value ? "selected" : ""}
                  onClick={() => sendControl("interaction", "setScreenRoutePreset", "screen-routes", preset.value)}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="screen-presentation-controls" aria-label="Screen presentation">
              <button
                type="button"
                className={screenPresentation.autoRedirect ? "selected" : ""}
                onClick={() => sendControl("interaction", "setScreenAutoRedirect", "screen-routing", !screenPresentation.autoRedirect)}
              >
                Auto redirect
              </button>
              <button
                type="button"
                className={screenPresentation.showMenu ? "selected" : ""}
                onClick={() => sendControl("interaction", "setScreenMenuVisible", "screen-menu", !screenPresentation.showMenu)}
              >
                Show menus
              </button>
              <button
                type="button"
                className={screenPresentation.showDebug ? "selected" : ""}
                onClick={() => sendControl("interaction", "setScreenDebugVisible", "screen-debug", !screenPresentation.showDebug)}
              >
                Show debug
              </button>
            </div>

            <div className="screen-tools">
              {screenSelectionModes.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={screenSelectionMode === mode.id ? "selected" : ""}
                  onClick={() => {
                    setScreenSelectionMode(mode.id);
                    setDragBox(null);
                    if (mode.id === "solid") clearSequence();
                  }}
                >
                  {mode.label}
                </button>
              ))}
              {sequenceGroups.length > 0 && (
                <button type="button" onClick={clearSequence}>清除顺序</button>
              )}
            </div>

            <div
              className={`screen-grid selection-mode-${screenSelectionMode}`}
              aria-label="Physical screen layout"
              ref={screenGridRef}
              onPointerDown={handleBoxPointerDown}
              onPointerMove={handleBoxPointerMove}
              onPointerUp={handleBoxPointerUp}
              onPointerCancel={() => setDragBox(null)}
            >
              {screenLayoutItems.map((screen) => {
                const route = screenRoutes[screen.id];
                return (
                  <button
                    key={screen.id}
                    type="button"
                    data-screen-id={screen.id}
                    className={[
                      snapshot.modules.interaction.screenId === screen.id ? "selected" : "",
                      sequenceOrderByScreen.has(screen.id) ? "sequenced" : "",
                      screen.id === "A1" ? "master-screen" : "",
                      route?.owner ? `owner-${route.owner}` : ""
                    ].filter(Boolean).join(" ")}
                    style={getScreenLayoutStyle(screen)}
                    onClick={() => handleScreenSelect(screen.id)}
                    title={route?.url || route?.owner || screen.id}
                  >
                    <strong>{screen.id}</strong>
                    <span>{formatOwner(route?.owner)}</span>
                    {sequenceOrderByScreen.has(screen.id) && (
                      <em className="screen-order">{sequenceOrderByScreen.get(screen.id)}</em>
                    )}
                  </button>
                );
              })}
              {dragBox && (
                <span className="selection-box" style={dragBoxStyle(dragBox)} />
              )}
            </div>

            <div className="interaction-readout">
              <span>Intensity {Math.round(snapshot.modules.interaction.intensity * 100)}%</span>
              <span>Growth {Math.round(snapshot.modules.interaction.treeGrowth * 100)}%</span>
              <span>{snapshot.modules.interaction.gestureActive ? "gesture active" : "gesture idle"}</span>
              <span>Route {snapshot.modules.interaction.screenRoutePreset}</span>
              <span>{screenPresentation.autoRedirect ? "auto redirect" : "manual routing"}</span>
              <span>{screenPresentation.showMenu ? "menus shown" : "menus hidden"}</span>
              <span>{screenPresentation.showDebug ? "debug shown" : "debug hidden"}</span>
            </div>

            {sequenceGroups.length > 0 && (
              <div className="sequence-step-control">
                <span>Step</span>
                {sequenceSteps.map((step) => (
                  <button
                    key={step}
                    type="button"
                    className={sequenceStep === step ? "selected" : ""}
                    onClick={() => setSequenceStep(step)}
                  >
                    {step}
                  </button>
                ))}
                <small>{Math.round(stepDurationMs(sequenceStep, snapshot.show.bpm))}ms @ {snapshot.show.bpm} BPM</small>
              </div>
            )}

            <div className="button-row">
              {interactionModes.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={snapshot.modules.interaction.mode === mode ? "selected" : ""}
                  onClick={() => triggerInteractionMode(mode)}
                >
                  {mode}
                </button>
              ))}
              <button type="button" onClick={pulseSelectedScreens}>
                <Zap size={15} /> Pulse
              </button>
              <button type="button" onClick={() => {
                clearSequence();
                void sendControl("interaction", "resetTree", "tree", true);
              }}>
                Reset tree
              </button>
              <button
                type="button"
                className={snapshot.modules.interaction.visualMode === "firework" ? "selected" : ""}
                onClick={() => sendControl(
                  "interaction",
                  "setVisualMode",
                  "visual-mode",
                  snapshot.modules.interaction.visualMode === "firework" ? "tree" : "firework"
                )}
              >
                <Sparkles size={15} /> {snapshot.modules.interaction.visualMode === "firework" ? "Firework" : "Tree"}
              </button>
            </div>

            <div className="route-table">
              {screenTopology.flatMap((row) => row).filter(Boolean).map((screenId) => {
                const route = screenRoutes[screenId];
                return (
                  <article key={screenId}>
                    <div>
                      <strong>{screenId}</strong>
                      <span>{route?.url || "4300 local status"}</span>
                      <small>{route?.updatedAt ? `updated ${new Date(route.updatedAt).toLocaleTimeString()}` : "waiting for route"}</small>
                    </div>
                    <div className="owner-switch" aria-label={`${screenId} owner`}>
                      {screenOwners.map((owner) => (
                        <button
                          key={owner.value}
                          type="button"
                          className={route?.owner === owner.value ? `selected owner-${owner.value}` : ""}
                          onClick={() => sendControl("interaction", "setScreenOwner", screenId, owner.value)}
                        >
                          {owner.label}
                        </button>
                      ))}
                    </div>
                  </article>
                );
              })}
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

function ScreenGateway({ screenId }: { screenId: string }) {
  const [snapshot, setSnapshot] = React.useState<PerformanceState | null>(null);
  const [connection, setConnection] = React.useState<ConnectionState>("connecting");
  const [message, setMessage] = React.useState("Resolving route");
  const route = snapshot?.modules.interaction.screenRoutes?.[screenId];
  const screenPresentation = snapshot?.modules.interaction.screenPresentation || {
    autoRedirect: true,
    showDebug: false,
    showMenu: false
  };
  const isValidScreen = Boolean(route);

  React.useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    async function boot() {
      try {
        const state = await fetchJson<PerformanceState>("/api/state");
        if (!closed) setSnapshot(state);
      } catch {
        if (!closed) {
          setConnection("offline");
          setMessage("4300 API unavailable");
        }
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
          clientId: `screen-gateway-${screenId}`,
          module: "dashboard",
          role: "screen-gateway",
          capabilities: ["state.read", "screen.route"]
        }));
      });
      socket.addEventListener("message", (event) => {
        const serverMessage = JSON.parse(event.data) as ServerMessage;
        if (isStateSnapshot(serverMessage)) setSnapshot(serverMessage.state);
        if (isStatePatch(serverMessage)) {
          setSnapshot((current) => serverMessage.state || (current ? applyStatePatch(current, serverMessage) : current));
        }
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
    };
  }, [screenId]);

  React.useEffect(() => {
    if (!snapshot) return;
    if (!route) {
      setMessage(`Unknown screen ${screenId}`);
      return;
    }
    if (!screenPresentation.autoRedirect) {
      setMessage(`Manual routing hold for ${formatOwner(route.owner)}`);
      return;
    }
    if ((route.owner === "vj" || route.owner === "baofa") && route.url) {
      setMessage(`Routing ${screenId} to ${formatOwner(route.owner)}`);
      window.location.replace(route.url);
      return;
    }
    setMessage(route.owner === "diagnostic" ? "Diagnostic hold" : "Screen is off");
  }, [route, screenId, screenPresentation.autoRedirect, snapshot]);

  return (
    <main className="screen-gateway">
      <section>
        <div className={`connection-dot ${connection}`} />
        <span>{connection}</span>
        <h1>{screenId}</h1>
        <p>{message}</p>
        {isValidScreen && route && (
          <dl>
            <div>
              <dt>Owner</dt>
              <dd>{formatOwner(route.owner)}</dd>
            </div>
            <div>
              <dt>URL</dt>
              <dd>{route.url || "4300 local status"}</dd>
            </div>
            <div>
              <dt>Auto Redirect</dt>
              <dd>{screenPresentation.autoRedirect ? "enabled" : "disabled"}</dd>
            </div>
            <div>
              <dt>Menus / Debug</dt>
              <dd>{screenPresentation.showMenu ? "menus shown" : "menus hidden"} · {screenPresentation.showDebug ? "debug shown" : "debug hidden"}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{new Date(route.updatedAt).toLocaleTimeString()}</dd>
            </div>
          </dl>
        )}
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
  const storageKey = `vad-panel-collapsed-${id || title}`;
  const [collapsed, setCollapsed] = React.useState(() => window.localStorage.getItem(storageKey) === "true");

  React.useEffect(() => {
    window.localStorage.setItem(storageKey, String(collapsed));
  }, [collapsed, storageKey]);

  return (
    <section id={id} className={[compact ? "panel compact" : "panel", collapsed ? "collapsed" : ""].join(" ")}>
      <div className="panel-heading">
        <h2>{icon}{title}</h2>
        <button
          type="button"
          className="panel-collapse-button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}
        </button>
      </div>
      {!collapsed && <div className="panel-body">{children}</div>}
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

function isStateSnapshot(message: ServerMessage): message is Extract<ServerMessage, { type: "state.snapshot" }> {
  return message.type === "state.snapshot";
}

function isStatePatch(message: ServerMessage): message is Extract<ServerMessage, { type: "state.patch" }> {
  return message.type === "state.patch";
}

function applyStatePatch(state: PerformanceState, message: Extract<ServerMessage, { type: "state.patch" }>): PerformanceState {
  return {
    ...state,
    updatedAt: message.updatedAt || Date.now(),
    modules: {
      ...state.modules,
      [message.module]: mergePatch(state.modules[message.module], message.patch)
    }
  };
}

function mergePatch<T>(target: T, patch: Record<string, unknown>): T {
  if (!isPlainRecord(target)) return patch as T;
  const next: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainRecord(value) && isPlainRecord(next[key])) {
      next[key] = mergePatch(next[key], value);
    } else {
      next[key] = value;
    }
  }
  return next as T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function formatOwner(owner: unknown) {
  if (owner === "vj") return "VJ";
  if (owner === "baofa") return "Baofa";
  if (owner === "off") return "Off";
  if (owner === "diagnostic") return "Diag";
  return "Unset";
}

function getScreenLayoutStyle(item: ScreenLayoutItem): React.CSSProperties {
  const width = item.width ?? 0.78;
  const height = item.height ?? 0.52;
  return {
    left: `${((item.col - width / 2) / stageBounds.width) * 100}%`,
    top: `${((item.row - height / 2) / stageBounds.height) * 100}%`,
    width: `${(width / stageBounds.width) * 100}%`,
    height: `${(height / stageBounds.height) * 100}%`,
    transform: item.rotate ? `rotate(${item.rotate}deg)` : undefined
  };
}

function getScreenIdFromPath() {
  const match = window.location.pathname.match(/^\/screen\/([^/]+)\/?$/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim().toUpperCase();
  } catch {
    return match[1].trim().toUpperCase();
  }
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

function normalizeRect(box: DragBox) {
  const left = Math.min(box.startX, box.currentX);
  const right = Math.max(box.startX, box.currentX);
  const top = Math.min(box.startY, box.currentY);
  const bottom = Math.max(box.startY, box.currentY);
  return { left, right, top, bottom };
}

function rectsIntersect(
  first: { left: number; right: number; top: number; bottom: number },
  second: { left: number; right: number; top: number; bottom: number }
) {
  return first.left <= second.right
    && first.right >= second.left
    && first.top <= second.bottom
    && first.bottom >= second.top;
}

function dragBoxStyle(box: DragBox): React.CSSProperties {
  const rect = normalizeRect(box);
  return {
    left: rect.left,
    top: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top
  };
}

function clampPoint(x: number, y: number, rect: DOMRect): DragBox {
  const currentX = Math.max(0, Math.min(rect.width, x));
  const currentY = Math.max(0, Math.min(rect.height, y));
  return {
    startX: currentX,
    startY: currentY,
    currentX,
    currentY
  };
}

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function stepDurationMs(step: SequenceStep, bpm: number) {
  const beatMs = 60000 / Math.max(1, bpm);
  const beatMultipliers: Record<SequenceStep, number> = {
    "1/16": 0.25,
    "1/8": 0.5,
    "1/4": 1,
    "1/2": 2,
    "1": 4
  };
  return beatMs * beatMultipliers[step];
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
