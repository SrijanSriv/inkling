import { createHash } from "node:crypto";
import path from "node:path";
import { readdirSync, existsSync, rmSync } from "node:fs";
import { config } from "./config.js";
import { appendHistory } from "./store.js";
import { readSealedJson, writeSealedJson } from "./vault.js";
import { log } from "./log.js";

type Notice = { id: string; message: string };
const inbox = () => path.join(config.dataDir, "operations-notices");
const receipts = () => path.join(config.dataDir, "operations-receipts.json");

// Only local maintenance scripts enqueue notices. No network endpoint or model tool.
export function enqueueOperation(key: string, message: string): void {
  if (!key || key.length > 200 || !message || message.length > 6000) throw new Error("Invalid operations notice.");
  const id = createHash("sha256").update(key).digest("hex");
  const file = path.join(inbox(), `${id}.sealed`);
  if (existsSync(file) || readSealedJson<string[]>(receipts(), []).includes(id)) return;
  if (existsSync(inbox()) && readdirSync(inbox()).length >= 100) throw new Error("Operations inbox is full.");
  writeSealedJson(file, { id, message });
}

export function startOperationNotifications(owner: string, send: (message: string) => Promise<void>, connected: () => boolean): void {
  if (process.env.INKLING_OPERATIONS_NOTIFICATIONS !== "true") return;
  let busy = false;
  const tick = async () => {
    if (busy || !connected()) return;
    busy = true;
    try {
      const name = existsSync(inbox()) && readdirSync(inbox()).sort().find(n => /^[a-f0-9]{64}\.sealed$/.test(n));
      if (!name) return;
      const file = path.join(inbox(), name);
      const notice = readSealedJson<Notice | null>(file, null);
      if (!notice) return;
      if (readSealedJson<string[]>(receipts(), []).includes(notice.id)) { rmSync(file); return; }
      await send(notice.message);
      appendHistory(owner, [{ role: "assistant", content: notice.message }]);
      const done = readSealedJson<string[]>(receipts(), []);
      writeSealedJson(receipts(), [...done, notice.id].slice(-1000));
      rmSync(file);
    } catch (err) { log.warn({ err }, "operations notification delayed"); }
    finally { busy = false; }
  };
  setInterval(() => void tick(), 30_000).unref();
  void tick();
}
