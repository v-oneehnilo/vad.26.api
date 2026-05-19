export const performanceSpec = {
  protocolVersion: "mixer.realtime.v1",
  performanceProtocolVersion: "performance.show.v1",
  transports: {
    rest: {
      spec: "GET /api/spec",
      stateSnapshot: "GET /api/state",
      eventStream: "GET /api/events",
      submitLegacyAudioFrame: "POST /api/mixer/frame",
      submitModuleState: "POST /api/modules/:module/state",
      submitControl: "POST /api/control",
      resetShow: "POST /api/show/reset",
      saveSnapshot: "POST /api/show/snapshot"
    },
    websocket: {
      endpoint: "ws://<host>/ws",
      clientMessages: [
        "client.hello",
        "module.statePatch",
        "module.telemetry",
        "control.command",
        "cue.fire",
        "heartbeat",
        "mixer.audioFrame",
        "ui.subscribe"
      ],
      serverMessages: [
        "state.snapshot",
        "state.patch",
        "mixer.audioFrame",
        "module.telemetry",
        "control.command",
        "control.ack",
        "client.presence",
        "heartbeat.ack",
        "error"
      ]
    }
  },
  modules: {
    allowed: ["audio", "visual", "interaction"],
    notes: {
      audio: "Music editor transport, slots, FX, .musicarr summary, realtime source levels.",
      visual: "Dynamic visual scene, presets, colors, FX, text, and audio drive mode.",
      interaction: "Multi-screen topology, screen role, mode, intensity, gesture state, and pulses."
    }
  },
  auth: {
    token: "Optional CONTROL_TOKEN. When configured, mutating REST requests use x-control-token or Bearer token; mutating WS messages include token."
  },
  schemas: {
    moduleStatePatch: {
      type: "object",
      required: ["module", "patch"],
      properties: {
        type: { const: "module.statePatch" },
        module: { enum: ["audio", "visual", "interaction"] },
        patch: { type: "object" },
        source: { type: "string" }
      }
    },
    controlCommand: {
      type: "object",
      required: ["target", "command"],
      properties: {
        type: { const: "control.command" },
        id: { type: "string" },
        module: { enum: ["show", "audio", "visual", "interaction"] },
        target: { type: "string" },
        command: {
          examples: [
            "play",
            "pause",
            "reset",
            "setBpm",
            "setPreset",
            "setScene",
            "setText",
            "setMode",
            "setIntensity",
            "pulseScreen"
          ]
        },
        value: { description: "Command-specific payload" },
        issuedBy: { type: "string" }
      }
    },
    audioFrame: {
      type: "object",
      required: ["sourceId", "level"],
      properties: {
        type: { const: "mixer.audioFrame" },
        sourceId: { type: "string" },
        level: { type: "number", minimum: 0, maximum: 1 },
        frequencyBands: {
          type: "array",
          items: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    }
  }
} as const;
