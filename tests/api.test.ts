import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import WebSocket from "ws";
import { createServer, type CreateServerOptions } from "../src/server.js";

async function withServer(fn: (baseUrl: string, server: http.Server) => Promise<void>, options: CreateServerOptions = {}) {
  const server = createServer({ persist: false, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}`, server);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("serves API spec and initial state", async () => {
  await withServer(async (baseUrl) => {
    const spec = await fetch(`${baseUrl}/api/spec`).then((res) => res.json());
    const state = await fetch(`${baseUrl}/api/state`).then((res) => res.json());

    assert.equal(spec.protocolVersion, "mixer.realtime.v1");
    assert.equal(spec.performanceProtocolVersion, "performance.show.v1");
    assert.equal(state.room.id, "classroom-a");
    assert.equal(state.show.id, "show-main");
    assert.ok(state.audioSources["mic-teacher"]);
    assert.ok(state.modules.visual.scene);
    assert.ok(state.modules.interaction.screenTopology.length);
  });
});

test("accepts legacy mixer frames and updates audio state", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/mixer/frame`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "mixer.audioFrame",
        sourceId: "mic-teacher",
        displayName: "Teacher Mic",
        level: 0.91,
        frequencyBands: [0.1, 0.4, 0.8]
      })
    });

    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.state.audioSources["mic-teacher"].level, 0.91);
    assert.equal(body.state.modules.audio.activeSourceId, "mic-teacher");
    assert.equal(body.state.modules.audio.masterLevel, 0.91);
  });
});

test("accepts module state patches", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/modules/visual/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "visual-module",
        patch: {
          scene: "Topology",
          preset: "Sonic Topology",
          text: { value: "LIVE" }
        }
      })
    });

    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.state.modules.visual.scene, "Topology");
    assert.equal(body.state.modules.visual.preset, "Sonic Topology");
    assert.equal(body.state.modules.visual.text.value, "LIVE");
    assert.equal(body.state.eventLog[0].type, "module.statePatch");
  });
});

test("normalizes flat interaction screen topology patches", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/modules/interaction/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "baofa",
        patch: {
          screenTopology: ["A1", "A2", "A3", "A4", "A5", "A6", "B1"],
          screenId: "B1"
        }
      })
    });

    const body = await response.json();
    assert.equal(response.status, 202);
    assert.deepEqual(body.state.modules.interaction.screenTopology, [
      ["A1", "A2", "A3", "A4", "A5", "A6"],
      ["B1"]
    ]);
    assert.equal(body.state.modules.interaction.screenTopology[0][0], "A1");
  });
});

test("accepts control commands and records control log", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "control.command",
        target: "mic-teacher",
        module: "audio",
        command: "setMute",
        value: true,
        issuedBy: "test"
      })
    });

    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.state.audioSources["mic-teacher"].muted, true);
    assert.equal(body.state.commandLog[0].command, "setMute");
  });
});

test("rejects malformed mixer frames and invalid modules", async () => {
  await withServer(async (baseUrl) => {
    const badFrame = await fetch(`${baseUrl}/api/mixer/frame`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: 0.4 })
    });
    const badFrameBody = await badFrame.json();
    assert.equal(badFrame.status, 400);
    assert.match(badFrameBody.error, /sourceId/);

    const badModule = await fetch(`${baseUrl}/api/modules/lights/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "online" })
    });
    const badModuleBody = await badModule.json();
    assert.equal(badModule.status, 400);
    assert.match(badModuleBody.error, /module/);
  });
});

test("resets show state", async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ module: "show", target: "show-main", command: "play" })
    });
    const reset = await fetch(`${baseUrl}/api/show/reset`, { method: "POST" });
    const body = await reset.json();
    assert.equal(reset.status, 202);
    assert.equal(body.state.show.status, "standby");
    assert.equal(body.state.show.positionMs, 0);
    assert.equal(body.state.modules.audio.transport, "stopped");
  });
});

test("persists and restores file snapshots", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vad-show-test-"));
  const snapshotPath = path.join(dir, "show-state.json");

  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/api/modules/interaction/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: { mode: "flow", intensity: 0.73 } })
    });
    const saved = await fetch(`${baseUrl}/api/show/snapshot`, { method: "POST" });
    assert.equal(saved.status, 202);
  }, { snapshotPath, persist: true, loadSnapshot: false });

  await withServer(async (baseUrl) => {
    const state = await fetch(`${baseUrl}/api/state`).then((res) => res.json());
    assert.equal(state.modules.interaction.mode, "flow");
    assert.equal(state.modules.interaction.intensity, 0.73);
  }, { snapshotPath, persist: false, loadSnapshot: true });
});

test("enforces CONTROL_TOKEN when configured", async () => {
  await withServer(async (baseUrl) => {
    const rejected = await fetch(`${baseUrl}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ module: "show", target: "show-main", command: "play" })
    });
    assert.equal(rejected.status, 401);

    const accepted = await fetch(`${baseUrl}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-control-token": "secret" },
      body: JSON.stringify({ module: "show", target: "show-main", command: "play" })
    });
    assert.equal(accepted.status, 202);
  }, { controlToken: "secret" });
});

test("websocket sends snapshots, presence, state patches, and control acknowledgements", async () => {
  await withServer(async (baseUrl) => {
    const ws = new WebSocket(baseUrl.replace("http", "ws") + "/ws");
    try {
      const snapshotPromise = waitForMessage(ws, (message) => message.type === "state.snapshot", 2000);
      await waitForSocketOpen(ws);

      const snapshot = await snapshotPromise;
      assert.equal(snapshot.state.show.id, "show-main");

      ws.send(JSON.stringify({
        type: "client.hello",
        clientId: "test-dashboard",
        module: "dashboard",
        role: "test"
      }));
      const presence = await waitForMessage(ws, (message) => message.type === "client.presence", 2000);
      assert.equal(presence.client.id, "test-dashboard");

      ws.send(JSON.stringify({
        type: "module.statePatch",
        module: "audio",
        source: "test-audio",
        patch: { activePreset: "Warehouse", masterLevel: 0.64 }
      }));
      const patch = await waitForMessage(ws, (message) => message.type === "state.patch" && message.module === "audio", 2000);
      assert.equal(patch.state.modules.audio.activePreset, "Warehouse");
      assert.equal(patch.state.modules.audio.masterLevel, 0.64);

      ws.send(JSON.stringify({
        type: "control.command",
        module: "visual",
        target: "visual-main",
        command: "setScene",
        value: "Pulse",
        issuedBy: "test-dashboard"
      }));
      const ack = await waitForMessage(ws, (message) => message.type === "control.ack", 2000);
      assert.equal(ack.command.command, "setScene");
      assert.equal(ack.command.module, "visual");

      ws.close();
      await waitForSocketClose(ws);
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
  });
});

function waitForSocketOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket open"));
    }, 1000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

function waitForSocketClose(ws: WebSocket) {
  return new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once("close", () => resolve());
  });
}

function waitForMessage(ws: WebSocket, predicate: (message: any) => boolean, timeoutMs = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);

    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}
