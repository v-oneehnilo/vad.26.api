const state = {
  snapshot: null,
  spec: null,
  socket: null,
  simTimer: null,
  selectedSourceId: null,
  sourceFilter: "all",
  histories: new Map(),
  lastFrameAt: null,
  frameCount: 0
};

const moduleColors = {
  audio: "var(--audio)",
  video: "var(--video)",
  interaction: "var(--interaction)",
  guest: "var(--guest)"
};

const samples = {
  frame: {
    type: "mixer.audioFrame",
    sourceId: "mic-teacher",
    displayName: "Teacher Mic",
    level: 0.67,
    rms: 0.58,
    peak: 0.81,
    gain: 0.74,
    muted: false,
    speaking: true,
    frequencyBands: [0.15, 0.31, 0.52, 0.76, 0.68, 0.42, 0.3, 0.21, 0.18, 0.14, 0.11, 0.09, 0.07, 0.06, 0.05, 0.04]
  },
  mute: {
    type: "control.command",
    target: "mic-teacher",
    module: "audio",
    command: "setMute",
    value: true,
    issuedBy: "visual-console"
  },
  gain: {
    type: "control.command",
    target: "line-media",
    module: "audio",
    command: "setGain",
    value: 0.62,
    issuedBy: "visual-console"
  }
};

const elements = {
  moduleList: document.querySelector("#moduleList"),
  connectionDot: document.querySelector("#connectionDot"),
  connectionText: document.querySelector("#connectionText"),
  simulateButton: document.querySelector("#simulateButton"),
  roomName: document.querySelector("#roomName"),
  roomMode: document.querySelector("#roomMode"),
  metricModules: document.querySelector("#metricModules"),
  metricPeak: document.querySelector("#metricPeak"),
  metricSpeaking: document.querySelector("#metricSpeaking"),
  metricLatency: document.querySelector("#metricLatency"),
  activeSourceName: document.querySelector("#activeSourceName"),
  activeLevelText: document.querySelector("#activeLevelText"),
  activeLevelBar: document.querySelector("#activeLevelBar"),
  spectrum: document.querySelector("#spectrum"),
  historyStrip: document.querySelector("#historyStrip"),
  sourceCount: document.querySelector("#sourceCount"),
  sourceFilters: document.querySelector("#sourceFilters"),
  sourceList: document.querySelector("#sourceList"),
  controlForm: document.querySelector("#controlForm"),
  controlTarget: document.querySelector("#controlTarget"),
  controlCommand: document.querySelector("#controlCommand"),
  controlValue: document.querySelector("#controlValue"),
  sourceInspector: document.querySelector("#sourceInspector"),
  controlLog: document.querySelector("#controlLog"),
  contractView: document.querySelector("#contractView")
};

async function boot() {
  state.spec = await fetchJson("/api/spec");
  state.snapshot = await fetchJson("/api/state");
  elements.contractView.textContent = JSON.stringify(state.spec, null, 2);
  Object.values(state.snapshot.audioSources).forEach((source) => pushHistory(source));
  render();
  connectSocket();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
  state.socket = socket;

  socket.addEventListener("open", () => setConnection(true));
  socket.addEventListener("close", () => {
    setConnection(false);
    window.setTimeout(connectSocket, 1200);
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state.snapshot") {
      state.snapshot = message.state;
      Object.values(state.snapshot.audioSources).forEach((source) => pushHistory(source, false));
      render();
    }
    if (message.type === "mixer.audioFrame" && state.snapshot) {
      state.snapshot.audioSources[message.sourceId] = message;
      state.snapshot.modules.audio.activeSourceId = message.sourceId;
      state.lastFrameAt = Date.now();
      state.frameCount += 1;
      pushHistory(message);
      render();
    }
  });
}

function setConnection(connected) {
  elements.connectionDot.classList.toggle("connected", connected);
  elements.connectionText.textContent = connected ? "WebSocket connected" : "Reconnecting";
}

function render() {
  if (!state.snapshot) return;

  const snapshot = state.snapshot;
  const sources = Object.values(snapshot.audioSources);
  const activeSource = snapshot.audioSources[snapshot.modules.audio.activeSourceId] || sources[0];
  if (!state.selectedSourceId || !snapshot.audioSources[state.selectedSourceId]) {
    state.selectedSourceId = activeSource.sourceId;
  }

  elements.roomName.textContent = snapshot.room.name;
  elements.roomMode.textContent = snapshot.room.mode;
  elements.activeSourceName.textContent = activeSource.displayName;
  elements.activeLevelText.textContent = `${Math.round(activeSource.level * 100)}%`;
  elements.activeLevelBar.style.width = `${activeSource.level * 100}%`;
  elements.sourceCount.textContent = `${sources.length} sources`;

  renderMetrics(snapshot, sources, activeSource);
  renderModules(snapshot.modules);
  renderSpectrum(activeSource.frequencyBands);
  renderHistory(activeSource.sourceId);
  renderSources(sources);
  renderTargets(sources);
  renderInspector(snapshot.audioSources[state.selectedSourceId] || activeSource);
  renderLog(snapshot.controlLog);
}

function renderMetrics(snapshot, sources, activeSource) {
  const modules = Object.values(snapshot.modules);
  const onlineCount = modules.filter((module) => ["online", "live"].includes(module.status)).length;
  const speakingCount = sources.filter((source) => source.speaking && !source.muted).length;
  const latencyText = state.lastFrameAt ? `${Math.max(0, Date.now() - state.lastFrameAt)}ms` : "--";

  elements.metricModules.textContent = `${onlineCount}/${modules.length}`;
  elements.metricPeak.textContent = `${Math.round((activeSource.peak || activeSource.level) * 100)}%`;
  elements.metricSpeaking.textContent = `${speakingCount}`;
  elements.metricLatency.textContent = latencyText;
}

function renderModules(modules) {
  elements.moduleList.innerHTML = Object.entries(modules).map(([name, module]) => `
    <div class="module-item">
      <i style="background:${moduleColors[name] || "var(--audio)"}"></i>
      <strong>${titleCase(name)}</strong>
      <span>${module.status}</span>
    </div>
  `).join("");
}

function renderSpectrum(bands = []) {
  const values = bands.length > 0 ? bands : Array.from({ length: 16 }, () => 0);
  elements.spectrum.innerHTML = values.map((value) => `
    <span style="height:${Math.max(8, value * 140)}px"></span>
  `).join("");
}

function renderHistory(sourceId) {
  const history = state.histories.get(sourceId) || [];
  const padded = [...Array(Math.max(0, 48 - history.length)).fill(0), ...history].slice(-48);
  elements.historyStrip.innerHTML = padded.map((value) => `
    <span style="height:${Math.max(3, value * 54)}px"></span>
  `).join("");
}

function renderSources(sources) {
  const filtered = sources
    .filter((source) => {
      if (state.sourceFilter === "speaking") return source.speaking && !source.muted;
      if (state.sourceFilter === "muted") return source.muted;
      if (state.sourceFilter === "mixer") return source.sourceId.startsWith("mixer:");
      return true;
    })
    .sort((a, b) => Number(b.level || 0) - Number(a.level || 0));

  if (filtered.length === 0) {
    elements.sourceList.innerHTML = `<div class="empty-state">No sources match this filter.</div>`;
    return;
  }

  elements.sourceList.innerHTML = filtered.map((source) => `
    <article class="source-card ${source.muted ? "muted" : ""} ${source.sourceId === state.selectedSourceId ? "selected" : ""}" data-source-id="${source.sourceId}">
      <div>
        <strong>${source.displayName}</strong>
        <small>${source.sourceId} · ${source.speaking ? "speaking" : "idle"}</small>
      </div>
      <div class="mini-meter" aria-label="${source.displayName} level">
        <span style="width:${source.muted ? 0 : source.level * 100}%"></span>
      </div>
      <div class="source-readout">${Math.round((source.level || 0) * 100)}%</div>
      <div class="source-actions">
        <button type="button" data-command="setMute" data-target="${source.sourceId}" data-value="${!source.muted}">${source.muted ? "Unmute" : "Mute"}</button>
        <button type="button" data-command="setGain" data-target="${source.sourceId}" data-value="0.8">Gain</button>
      </div>
    </article>
  `).join("");
}

function renderInspector(source) {
  const timestamp = source.timestamp ? new Date(source.timestamp).toLocaleTimeString() : "--";
  elements.sourceInspector.innerHTML = `
    <div class="inspector-heading">
      <span>Selected source</span>
      <strong>${source.displayName}</strong>
    </div>
    <dl>
      <div><dt>Source ID</dt><dd>${source.sourceId}</dd></div>
      <div><dt>Device</dt><dd>${source.deviceId || "--"}</dd></div>
      <div><dt>Level</dt><dd>${Math.round((source.level || 0) * 100)}%</dd></div>
      <div><dt>RMS / Peak</dt><dd>${Math.round((source.rms || 0) * 100)}% / ${Math.round((source.peak || 0) * 100)}%</dd></div>
      <div><dt>Gain</dt><dd>${Math.round((source.gain || 0) * 100)}%</dd></div>
      <div><dt>Status</dt><dd>${source.muted ? "muted" : source.speaking ? "speaking" : "idle"}</dd></div>
      <div><dt>Updated</dt><dd>${timestamp}</dd></div>
    </dl>
  `;
}

function renderTargets(sources) {
  const previous = elements.controlTarget.value;
  elements.controlTarget.innerHTML = sources.map((source) => `
    <option value="${source.sourceId}">${source.displayName}</option>
  `).join("");
  if (previous) elements.controlTarget.value = previous;
}

function renderLog(log = []) {
  elements.controlLog.innerHTML = log.slice(0, 8).map((item) => `
    <div class="log-item">
      <strong>${item.command}</strong> ${item.target} = ${JSON.stringify(item.value)}
      <br />${new Date(item.timestamp).toLocaleTimeString()}
    </div>
  `).join("");
}

function titleCase(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function pushHistory(source, countFrame = true) {
  if (!source?.sourceId) return;
  const history = state.histories.get(source.sourceId) || [];
  history.push(source.muted ? 0 : Number(source.level || 0));
  state.histories.set(source.sourceId, history.slice(-48));
  if (countFrame) state.lastFrameAt = Date.now();
}

function parseControlValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const number = Number(raw);
  return Number.isFinite(number) ? number : raw;
}

async function sendCommand(command) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(command));
    return;
  }

  await fetchJson("/api/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command)
  });
}

function makeFrame(source) {
  const level = source.muted ? 0 : Math.max(0.02, Math.min(0.98, source.level + (Math.random() - 0.45) * 0.28));
  const bands = Array.from({ length: 16 }, (_, index) => {
    const curve = Math.sin((index / 15) * Math.PI);
    return Math.max(0.03, Math.min(1, level * (0.35 + curve * 0.9) + Math.random() * 0.18));
  });

  return {
    type: "mixer.audioFrame",
    sourceId: source.sourceId,
    deviceId: source.deviceId,
    displayName: source.displayName,
    timestamp: Date.now(),
    level,
    rms: Math.max(0, level - 0.08),
    peak: Math.min(1, level + 0.16),
    gain: source.gain,
    muted: source.muted,
    speaking: level > 0.24,
    frequencyBands: bands
  };
}

elements.sourceList.addEventListener("click", async (event) => {
  const card = event.target.closest("[data-source-id]");
  if (card) {
    state.selectedSourceId = card.dataset.sourceId;
    render();
  }

  const button = event.target.closest("button[data-command]");
  if (!button) return;
  event.stopPropagation();

  await sendCommand({
    type: "control.command",
    target: button.dataset.target,
    module: "audio",
    command: button.dataset.command,
    value: parseControlValue(button.dataset.value),
    issuedBy: "visual-console"
  });
});

elements.sourceFilters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  state.sourceFilter = button.dataset.filter;
  elements.sourceFilters.querySelectorAll("button").forEach((item) => {
    item.classList.toggle("active", item === button);
  });
  render();
});

elements.controlForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const command = elements.controlCommand.value;
  await sendCommand({
    type: "control.command",
    target: elements.controlTarget.value,
    module: command === "focusVideo" ? "video" : command === "setInteractionMode" ? "interaction" : command === "setGuestOnStage" ? "guest" : "audio",
    command,
    value: parseControlValue(elements.controlValue.value),
    issuedBy: "visual-console"
  });
});

elements.simulateButton.addEventListener("click", () => {
  if (state.simTimer) {
    window.clearInterval(state.simTimer);
    state.simTimer = null;
    elements.simulateButton.textContent = "Start Mixer Sim";
    return;
  }

  state.simTimer = window.setInterval(() => {
    const sources = Object.values(state.snapshot.audioSources);
    const source = sources[Math.floor(Math.random() * sources.length)];
    state.socket?.send(JSON.stringify(makeFrame(source)));
  }, 280);
  elements.simulateButton.textContent = "Stop Mixer Sim";
});

document.querySelector(".endpoint-list").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-sample]");
  if (!button) return;
  elements.contractView.textContent = JSON.stringify(samples[button.dataset.sample], null, 2);
});

boot().catch((error) => {
  elements.connectionText.textContent = error.message;
});
