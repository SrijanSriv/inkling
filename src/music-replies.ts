const words = (value: unknown, max = 300) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max) : "";
const song = (track: any) => {
  const title = words(track?.title), artist = words(track?.artist, 200);
  return title ? `“${title}”${artist ? ` by ${artist}` : ""}` : "the song";
};
const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
function queueInfo(data: any): string {
  const requested = count(data.requested), radio = count(data.radioTracks);
  let text = requested + radio === 0 ? "Nothing else is queued." : `${requested + radio} ${requested + radio === 1 ? "song is" : "songs are"} queued${radio ? ` (${requested} requested, ${radio} from radio)` : ""}.`;
  if (data.next?.title) text += ` Next up: ${song(data.next)}.`;
  if (data.radio) text += " Radio is on.";
  return text;
}
/** Deterministic fallback: tool data must never become a JSON chat message. */
export function formatMusicReply(value: unknown): string {
  const r = value as any, data = r?.data;
  if (!r || typeof r !== "object") return "I couldn't read the music result. Please check the player status.";
  if (r.ok === false && r.code !== "selection_required") return words(r.message, 1000) || "That music request failed; your queued requests were retained.";
  if (Array.isArray(data)) {
    if (!data.length) return r.action === "playlist_list" ? "No playlists have been saved yet." : "No matching songs were found. Playback is unchanged.";
    return `Found these ${r.action === "playlist_list" ? "saved playlists" : "videos"}:\n` + data.map((t, i) => `${i + 1}. ${t.name ? `${words(t.name)} (${count(t.songs)} songs)` : song(t)}`).join("\n");
  }
  if (data?.playback) {
    const speaker = words(data.speaker, 200);
    const where = speaker ? ` on ${speaker}` : " on the Pi's audio output";
    let text: string;
    switch (data.playback) {
      case "playing": text = `${song(data.current)} is playing${where}.`; break;
      case "paused": text = `${song(data.current)} is paused${where}.`; break;
      case "buffering": text = `${song(data.current)} is buffering${where}.`; break;
      case "loading": text = `Loading ${song(data.preparing || data.current)}${where}; playback isn't confirmed yet.`; break;
      case "speaker_disconnected": text = `${speaker || "The configured speaker"} is disconnected. Connect it, then resume.`; break;
      case "error": text = `Music isn't playing. ${words(data.lastError?.message, 600) || "The track failed to load; queued requests were retained."}`; break;
      default: text = `Music is stopped.${data.current?.title ? ` Last song: ${song(data.current)}.` : ""}`;
    }
    return `${text} ${queueInfo(data)}${data.muted ? " The player is muted." : data.volume === 0 ? " Player volume is at zero." : ""}`;
  }
  if (Array.isArray(data?.songs)) {
    if (!data.songs.length) return "The upcoming queue is empty.";
    return `Upcoming songs:\n${data.songs.map((e: any, i: number) => `${i + 1}. ${song(e.track)}${e.kind === "radio" ? " (radio)" : ""}`).join("\n")}`;
  }
  if (data?.song) return `${song(data.song)} is queued${typeof data.position === "number" ? ` at position ${data.position}` : ""}.`;
  return words(r.message, 1000) || "The music request finished, but no playback details were returned.";
}
export function rawMusicReply(text: string): boolean {
  return /Music result \(information only\)|Track loaded and advancing audio output confirmed|"(?:ok|action|message|data|playback|current|audioOutput|speakerAvailable|audibleInRoom|radioTracks)"\s*:/i.test(text);
}

/** Playback replies must include the known song, source artist/channel, speaker and queue context. */
export function missingMusicDetails(text: string, results: { name: string; output: string }[]): boolean {
  const last = results.findLast(r => r.name === "music_control");
  const marker = "Music result (information only):\n";
  const at = last?.output.indexOf(marker) ?? -1;
  if (!last || at < 0) return false;
  try {
    const r = JSON.parse(last.output.slice(at + marker.length)), d = r.data;
    if (!r.ok || !["play", "next", "previous", "resume", "status", "playlist_play"].includes(r.action) || !["playing", "paused", "buffering"].includes(d?.playback)) return false;
    const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const plain = normalize(text);
    const artist = words(d.current?.artist), speaker = words(d.speaker);
    const titleWords = normalize(words(d.current?.title)).split(" ").filter(w => w.length > 3 && !/^(?:official|audio|video|song|title|lyrics|lyrical)$/.test(w));
    return (!!artist && !plain.includes(normalize(artist))) || (!!speaker && !plain.includes(normalize(speaker))) ||
      (titleWords.length > 0 && !titleWords.some(w => plain.includes(w))) || !/\b(?:queue|queued|next|nothing else|agla|aage|baaki)\b/i.test(text);
  } catch { return false; }
}
