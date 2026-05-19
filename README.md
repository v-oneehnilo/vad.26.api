# VAD Public Performance Backend

Public backend and show-control dashboard for one live performance made of three cooperating modules: audio, visual effects, and multi-screen interaction.

The first version is built for local or LAN rehearsal/show control. It keeps the authoritative show state in memory and persists a debounced JSON snapshot to disk so the server can recover after a restart.

## Stack

- Node 20
- TypeScript
- Express
- WebSocket (`ws`)
- Vite + React + TypeScript dashboard

## Run

```bash
npm install
npm run build
npm start
```

Open `http://localhost:3000` by default.

Useful environment variables:

- `PORT`: HTTP/WS port. Default: `3000`.
- `SHOW_STATE_PATH`: snapshot path. Default: `data/show-state.json`.
- `CONTROL_TOKEN`: optional shared control token. When set, mutating REST calls and WS control/state messages must include the token.

Development mode:

```bash
npm run dev
```

Tests:

```bash
npm test
```

## Dashboard

The root route serves the show-control dashboard in production. The first screen is the control surface, not a landing page.

Main panels:

- Show transport, BPM, position, and last command ack.
- Module connection status.
- Audio source matrix and audio presets.
- Visual scene, preset, color, and text controls.
- Multi-screen topology, screen targeting, mode, pulse, intensity, and tree reset.
- Live event log and connected clients.

All dashboard commands go through the same `/api/control` contract used by external module adapters.

## REST API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/spec` | Returns protocol metadata, REST routes, WS message types, and state fields. |
| `GET` | `/api/state` | Returns the full show snapshot. |
| `POST` | `/api/mixer/frame` | Compatibility endpoint for legacy realtime audio frames. |
| `POST` | `/api/modules/:module/state` | Applies a module state patch. `module` must be `audio`, `visual`, or `interaction`. |
| `POST` | `/api/control` | Issues a normalized show-control command. |
| `POST` | `/api/show/reset` | Resets the current show state to defaults. |
| `POST` | `/api/show/snapshot` | Forces an immediate snapshot save. |
| `GET` | `/api/events` | Read-only Server-Sent Events stream. |

If `CONTROL_TOKEN` is configured, pass it as either:

- `x-control-token: <token>`
- `Authorization: Bearer <token>`

## WebSocket

Connect to:

```text
ws://localhost:3000/ws
```

Client-to-server messages:

- `client.hello`
- `heartbeat`
- `mixer.audioFrame`
- `module.statePatch`
- `module.telemetry`
- `control.command`
- `cue.fire`
- `ui.subscribe`

Server-to-client messages:

- `state.snapshot`
- `state.patch`
- `control.command`
- `control.ack`
- `client.presence`
- `error`

When `CONTROL_TOKEN` is configured, pass it with `?token=<token>` on the WS URL, or include `token` / `authToken` on mutating messages.

## Command Format

```json
{
  "module": "visual",
  "target": "show-main",
  "command": "setScene",
  "value": "Liquid",
  "issuedBy": "dashboard"
}
```

The server adds an `id` and `timestamp` if the client does not provide them, applies known commands to the central state, appends the command log, broadcasts the command, and returns an ack.

## Module State Patch

```json
{
  "screenId": "MASTER",
  "mode": "flow",
  "intensity": 0.72,
  "treeGrowth": 0.41,
  "gestureActive": true
}
```

Send it to:

```text
POST /api/modules/interaction/state
```

or over WS:

```json
{
  "type": "module.statePatch",
  "module": "interaction",
  "patch": {
    "mode": "flow",
    "intensity": 0.72
  }
}
```

## Show State

The top-level state is centered around one `show`:

- `show`: status, timing, BPM, beat, bar.
- `modules.audio`: transport, master level, active tab, slots, FX, and `.musicarr` summary.
- `modules.visual`: scene, preset, colors, FX, text, audio-drive mode, fullscreen, and memory summary.
- `modules.interaction`: screen topology, selected screen, overview/master mode, intensity, tree growth, gesture state, and last interaction.
- `clients`: connected module/dashboard instances.
- `commandLog` and `eventLog`: bounded recent history for dashboard review.

The server still exposes legacy mixer fields such as `audioSources` and `/api/mixer/frame` for compatibility.

## Current Scope

This repository is now the common backend and dashboard only. The audio, visual, and multi-screen module repositories are not modified in this phase.

Known follow-up prerequisites before module adapters:

- The local `baofa` remote did not match the user-provided GitHub URL during inventory.
- A local `visual-dynamic-effect` Git repository was not found during inventory.
- The first version has no login system. Use `CONTROL_TOKEN` for a shared local control token when needed.
