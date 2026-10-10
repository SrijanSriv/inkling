import { createServer, createConnection, type Socket } from "node:net";
import { mkdirSync, chmodSync, existsSync, unlinkSync, lstatSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { readSealedJson, writeSealedJson } from "./vault.js";
import { MusicEngine, emptyMusicState } from "./music-engine.js";
import { YoutubeSource } from "./music-source.js";
import { MpvPlayer } from "./music-mpv.js";
import { musicFailure, validateMusicRequest, type MusicReply } from "./music-types.js";

const track = z.object({ id: z.string().regex(/^[\w-]{11}$/), title: z.string().max(300), artist: z.string().max(200), url: z.string().regex(/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/), duration: z.number().nonnegative().optional() });
const stateSchema = z.object({ current: track.nullable(), queue: z.array(z.object({ track, kind: z.enum(["requested", "radio"]) })).max(200), history: z.array(track).max(100), volume: z.number().min(0).max(100), position: z.number().nonnegative(), desired: z.enum(["playing", "paused", "stopped"]), radio: z.boolean(), playlists: z.record(z.string().max(80), z.array(track).max(201)).refine(v => Object.keys(v).length <= 30) });
const replySchema = z.object({ ok: z.boolean(), code: z.string().optional(), message: z.string(), data: z.unknown().optional() });
const savedSchema = z.object({ state: stateSchema, receipts: z.array(z.object({ id: z.string(), signature: z.string(), reply: replySchema.optional() })).max(256) });
async function occupied(socketPath: string) {
  return new Promise<boolean>(resolve => {
    const s = createConnection(socketPath); const timer = setTimeout(() => { s.destroy(); resolve(true); }, 500);
    s.on("connect", () => { clearTimeout(timer); s.destroy(); resolve(true); });
    s.on("error", () => { clearTimeout(timer); s.destroy(); resolve(false); });
  });
}
async function main() {
  if (!config.musicSocket) throw new Error("Set INKLING_MUSIC_SOCKET before starting the music service.");
  const dir = path.dirname(config.musicSocket);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Use a dedicated directory; never chmod a shared runtime directory or follow a symlink.
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("Music socket needs a private directory owned by this user (mode 700).");
  if (existsSync(config.musicSocket)) { if (await occupied(config.musicSocket)) throw new Error("Music service is already running."); unlinkSync(config.musicSocket); }
  const file = path.join(config.dataDir, "music.json");
  const parsed = savedSchema.safeParse(readSealedJson(file, { state: emptyMusicState(), receipts: [] }));
  if (!parsed.success) throw new Error("Saved music state is invalid. It was left untouched.");
  const saved = parsed.data;
  const persist = () => writeSealedJson(file, saved);
  persist(); // Validate the encryption key before accepting requests.
  const engine = new MusicEngine(saved.state, new YoutubeSource(), new MpvPlayer(path.join(dir, "mpv.sock")), s => { saved.state = s; persist(); });
  const pending = new Map<string, { signature: string; work: Promise<MusicReply> }>();
  const readOnly = new Set(["search", "status", "queue", "playlist_list"]);
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    if (sockets.size >= 64) { socket.destroy(); return; }
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); socket.setTimeout(100_000, () => socket.destroy());
    let buffer = "", handled = false;
    socket.on("data", chunk => {
      if (handled) return; buffer += chunk.toString();
      if (buffer.length > 16 * 1024) { socket.destroy(); return; }
      const newline = buffer.indexOf("\n"); if (newline < 0) return; handled = true;
      const run = async (): Promise<MusicReply> => {
        const r = validateMusicRequest(JSON.parse(buffer.slice(0, newline)));
        const signature = JSON.stringify([r.action, r.query ?? null, r.volume ?? null]);
        const receipt = saved.receipts.find(v => v.id === r.id);
        if (receipt && receipt.signature !== signature) return { ok: false, code: "request_conflict", message: "This request ID was already used for another music action." };
        const active = pending.get(r.id);
        if (active) return active.signature === signature ? active.work : { ok: false, code: "request_conflict", message: "This request ID is already processing another music action." };
        if (receipt) return receipt.reply || { ok: false, code: "interrupted", message: "This request was interrupted by a music service restart. It was not repeated. Inspect status and queue before retrying." };
        if (!readOnly.has(r.action)) { saved.receipts.push({ id: r.id, signature }); saved.receipts = saved.receipts.slice(-256); persist(); }
        const work = engine.handle(r);
        pending.set(r.id, { signature, work });
        try {
          const result = await work;
          const item = saved.receipts.find(v => v.id === r.id); if (item) { item.reply = result; persist(); }
          return result;
        } finally { pending.delete(r.id); }
      };
      void run().catch(musicFailure).then(result => { if (!socket.destroyed) socket.end(JSON.stringify(result) + "\n"); });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.musicSocket!, () => { chmodSync(config.musicSocket!, 0o600); resolve(); }); });
  let shuttingDown = false;
  const timer = setInterval(() => { void engine.checkpoint().catch(() => {}); }, 10_000);
  const stop = async () => {
    if (shuttingDown) return; shuttingDown = true; clearInterval(timer);
    server.close(); await engine.close();
    for (const socket of sockets) socket.destroy();
    try { unlinkSync(config.musicSocket!); } catch {}
  };
  process.on("SIGTERM", () => { void stop().then(() => process.exit(0)); });
  process.on("SIGINT", () => { void stop().then(() => process.exit(0)); });
  console.info("Inkling music service ready."); // No queries, titles, stream URLs or contact details in logs.
  void engine.restore();
}
void main().catch(() => { console.error("Inkling music service could not start. Check configuration, private socket directory and encrypted state."); process.exitCode = 1; });
