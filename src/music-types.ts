export const musicActions = ["search", "play", "pause", "resume", "stop", "next", "previous", "volume", "volume_delta", "status", "queue_add", "queue_next", "queue", "queue_clear", "radio_on", "radio_off", "playlist_save", "playlist_play", "playlist_list", "playlist_delete"] as const;
export type MusicAction = typeof musicActions[number];
export type MusicRequest = { id: string; action: MusicAction; query?: string | null; volume?: number | null };
export type Track = { id: string; title: string; artist: string; url: string; duration?: number };
export type Entry = { track: Track; kind: "requested" | "radio" };
export type Playback = { active: boolean; paused: boolean; buffering: boolean; position: number; duration: number; volume: number; muted: boolean; output: string | null; device?: string | null; deviceAvailable?: boolean | null };
export type MusicState = { current: Track | null; queue: Entry[]; history: Track[]; volume: number; position: number; desired: "playing" | "paused" | "stopped"; radio: boolean; playlists: Record<string, Track[]> };
export type MusicReply = { ok: boolean; code?: string; message: string; data?: unknown };
export class MusicError extends Error {
  constructor(readonly code: string, message: string, readonly data?: unknown) { super(message); }
}
export function musicFailure(error: unknown): MusicReply {
  return error instanceof MusicError ? { ok: false, code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
    : { ok: false, code: "internal", message: "Music could not complete this operation. Saved requests were retained." };
}
export function validateMusicRequest(value: unknown): MusicRequest {
  const r = value as MusicRequest;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !/^[\w:-]{1,160}$/.test(r.id) || !musicActions.includes(r.action)) throw new MusicError("invalid_request", "Invalid music command.");
  if (["search", "play", "queue_add", "queue_next", "playlist_save", "playlist_play", "playlist_delete"].includes(r.action) &&
    (typeof r.query !== "string" || !r.query.trim() || r.query.length > 500 || /[\x00-\x1f\x7f]/.test(r.query) || r.query.startsWith("-"))) throw new MusicError("invalid_query", "Give a song, video URL or playlist name (1–500 characters).");
  if (["volume", "volume_delta"].includes(r.action) && (!Number.isInteger(r.volume) || r.volume! > 100 || r.volume! < (r.action === "volume" ? 0 : -100))) throw new MusicError("invalid_volume", "Volume must be a whole percentage; relative changes must be between -100 and 100.");
  return { id: r.id, action: r.action, query: r.query?.trim(), volume: r.volume };
}
