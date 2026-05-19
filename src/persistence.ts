import fs from "node:fs";
import path from "node:path";
import { PerformanceState } from "./types.js";
import { hydrateState } from "./state.js";

export function loadSnapshotSync(snapshotPath: string): PerformanceState | null {
  try {
    if (!fs.existsSync(snapshotPath)) return null;
    const raw = fs.readFileSync(snapshotPath, "utf8");
    return hydrateState(JSON.parse(raw));
  } catch (error) {
    console.warn(`Could not load show snapshot from ${snapshotPath}:`, error);
    return null;
  }
}

export class SnapshotWriter {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly snapshotPath: string,
    private readonly delayMs = 250
  ) {}

  schedule(state: PerformanceState) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush(state);
    }, this.delayMs);
  }

  async flush(state: PerformanceState) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await fs.promises.mkdir(path.dirname(this.snapshotPath), { recursive: true });
    await fs.promises.writeFile(this.snapshotPath, JSON.stringify(state, null, 2), "utf8");
  }
}
