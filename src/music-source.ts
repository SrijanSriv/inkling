import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MusicError, type Track } from "./music-types.js";
const exec = promisify(execFile);
const privacy = ["--ignore-config", "--no-cache-dir", "--no-cookies", "--no-cookies-from-browser", "--no-warnings", "--no-playlist"];
export interface MusicSource {
  search(query: string, signal?: AbortSignal): Promise<Track[]>;
  resolve(track: Track, signal?: AbortSignal): Promise<{ url: string; headers: Record<string, string> }>;
  mix(track: Track, signal?: AbortSignal): Promise<Track[]>;
}
export function parseMusicTracks(text: string): Track[] {
  const seen = new Set<string>();
  return text.split("\n").flatMap(line => {
    try {
      const d = JSON.parse(line);
      if (typeof d.id !== "string" || !/^[\w-]{11}$/.test(d.id) || (d.ie_key && d.ie_key !== "Youtube") || typeof d.title !== "string" || seen.has(d.id)) return [];
      seen.add(d.id);
      return [{ id: d.id, title: d.title.slice(0, 300), artist: String(d.uploader || d.channel || "").slice(0, 200), url: `https://www.youtube.com/watch?v=${d.id}`, ...(typeof d.duration === "number" && Number.isFinite(d.duration) && d.duration >= 0 ? { duration: d.duration } : {}) }];
    } catch { return []; }
  });
}
export function youtubeVideo(query: string): string | undefined {
  if (!/^https?:\/\//i.test(query)) return undefined;
  try {
    const u = new URL(query);
    if (u.protocol !== "https:" || u.username || u.password || u.port) throw new Error();
    const id = u.hostname === "youtu.be" ? u.pathname.slice(1) : ["youtube.com", "www.youtube.com", "music.youtube.com"].includes(u.hostname) && u.pathname === "/watch" ? u.searchParams.get("v") : null;
    if (!id || !/^[\w-]{11}$/.test(id)) throw new Error();
    return `https://www.youtube.com/watch?v=${id}`;
  } catch { throw new MusicError("invalid_url", "Use a YouTube video link, not a channel, playlist or other website."); }
}
export class YoutubeSource implements MusicSource {
  private candidates = new Map<string, Track>();
  constructor(private executable = process.env.INKLING_YTDLP || "yt-dlp") {}
  private async run(args: string[], signal?: AbortSignal): Promise<string> {
    try {
      const { stdout } = await exec(this.executable, [...privacy, "--js-runtimes", `node:${process.execPath}`, ...args], { timeout: 22_000, signal, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
      return stdout;
    } catch (error) {
      if (signal?.aborted) throw new MusicError("cancelled", "Music request cancelled.");
      const e = error as { code?: string; killed?: boolean; stderr?: string };
      if (e.code === "ENOENT") throw new MusicError("dependency_missing", "yt-dlp is not installed or not on the music service's path.");
      const detail = e.stderr || ""; // Classify locally; never return URLs, cookies or raw extractor output.
      if (/sign in|login|bot|age.restrict|private video|members.only|403|429/i.test(detail)) throw new MusicError("source_access", "YouTube refused access to this video. Try another matching version.");
      if (/unavailable|removed|not available|copyright|no video results|unsupported url/i.test(detail)) throw new MusicError("unavailable", "This YouTube video is unavailable. Try another matching version.");
      throw new MusicError(e.killed ? "source_timeout" : "source_network", "YouTube lookup failed or timed out. Playback and queued requests were not reset.");
    }
  }
  async search(query: string, signal?: AbortSignal): Promise<Track[]> {
    const direct = youtubeVideo(query);
    if (direct) { const cached = this.candidates.get(new URL(direct).searchParams.get("v")!); if (cached) return [cached]; }
    const tracks = parseMusicTracks(await this.run([direct || `ytsearch8:${query}`, "--flat-playlist", "--dump-json", "--quiet"], signal)).slice(0, 5);
    for (const t of tracks) this.candidates.set(t.id, t);
    while (this.candidates.size > 100) this.candidates.delete(this.candidates.keys().next().value!);
    return tracks;
  }
  async resolve(track: Track, signal?: AbortSignal) {
    let text: string;
    try { text = await this.run([track.url, "--dump-single-json", "--skip-download", "--format", "bestaudio/best", "--quiet"], signal); }
    catch (e) {
      // Retry only transport failures, never unavailable/private videos or a different song.
      if (!(e instanceof MusicError) || !["source_network", "source_timeout"].includes(e.code)) throw e;
      text = await this.run([track.url, "--dump-single-json", "--skip-download", "--format", "bestaudio/best", "--quiet"], signal);
    }
    try {
      const d = JSON.parse(text), u = new URL(d.url);
      if (u.protocol !== "https:" || !/(^|\.)(googlevideo\.com|youtube\.com)$/.test(u.hostname)) throw new Error();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.http_headers || {})) if (/^(user-agent|referer|origin|accept|accept-language)$/i.test(k) && typeof v === "string" && !/[\r\n]/.test(v)) headers[k] = v;
      return { url: u.href, headers };
    } catch { throw new MusicError("no_audio", "YouTube did not return a playable audio stream for this video."); }
  }
  async mix(track: Track, signal?: AbortSignal): Promise<Track[]> {
    return parseMusicTracks(await this.run([`https://www.youtube.com/watch?v=${track.id}&list=RD${track.id}`, "--yes-playlist", "--playlist-end", "12", "--flat-playlist", "--dump-json", "--quiet"], signal));
  }
}
