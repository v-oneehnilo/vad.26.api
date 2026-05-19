import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createAppServer } from "../src/server.js";

const { app } = createAppServer({
  persist: false,
  loadSnapshot: false,
  serveClient: false
});

export default function handler(req: VercelRequest, res: VercelResponse) {
  return app(req, res);
}
