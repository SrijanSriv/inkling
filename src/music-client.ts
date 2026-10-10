import { createConnection } from "node:net";
import { MusicError, type MusicReply, type MusicRequest } from "./music-types.js";
export function requestMusic(socketPath: string, request: MusicRequest, timeout = 90_000): Promise<MusicReply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let text = "", settled = false;
    const finish = (error?: Error, result?: MusicReply) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result!); };
    const timer = setTimeout(() => finish(new MusicError("request_timeout", "The music request has not returned yet; it may still be processing. Check status before repeating it.")), timeout);
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("error", () => finish(new MusicError("service_unavailable", "The music service is not reachable. Check inkling-music.service; queued songs are saved separately.")));
    socket.on("end", () => { if (!settled) finish(new MusicError("connection_lost", "Music service connection lost. Check status before repeating the action.")); });
    socket.on("data", chunk => {
      text += chunk.toString();
      if (text.length > 512 * 1024) { finish(new MusicError("invalid_response", "Music service returned too much data.")); return; }
      const end = text.indexOf("\n"); if (end < 0) return;
      try { const reply = JSON.parse(text.slice(0, end)); if (typeof reply.ok !== "boolean" || typeof reply.message !== "string") throw new Error(); finish(undefined, reply); }
      catch { finish(new MusicError("invalid_response", "Music service returned an invalid response.")); }
    });
  });
}
