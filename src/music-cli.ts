import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { requestMusic } from "./music-client.js";
import { validateMusicRequest, musicFailure } from "./music-types.js";
async function main() {
  const [action, ...words] = process.argv.slice(2);
  if (!config.musicSocket) throw new Error("Set INKLING_MUSIC_SOCKET.");
  const volumeAction = action === "volume" || action === "volume_delta";
  const request = validateMusicRequest({ id: randomUUID(), action, query: volumeAction ? null : words.join(" "), volume: volumeAction ? Number(words[0]) : null });
  const reply = await requestMusic(config.musicSocket, request);
  console.log(JSON.stringify(reply, null, 2)); if (!reply.ok) process.exitCode = 1;
}
void main().catch(e => { console.log(JSON.stringify(musicFailure(e))); process.exitCode = 1; });
