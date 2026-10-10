import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { unlinkSync } from "node:fs";
import { MusicError, type Playback } from "./music-types.js";
export interface AudioPlayer {
  onEnd: (reason: string) => void;
  onLost: () => void;
  load(stream: { url: string; headers: Record<string, string> }, signal: AbortSignal, position?: number, paused?: boolean): Promise<void>;
  status(): Promise<Playback>;
  pause(value: boolean): Promise<void>;
  volume(value: number): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export class MpvPlayer implements AudioPlayer {
  onEnd = (_reason: string) => {};
  onLost = () => {};
  private child?: ChildProcess;
  private socket?: Socket;
  private starting?: Promise<void>;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private id = 0;
  private events = new EventEmitter();
  private loading = false;
  constructor(private ipc: string, private executable = process.env.INKLING_MPV || "mpv", private speaker = process.env.INKLING_MUSIC_SPEAKER) {}
  private disconnected() {
    this.socket?.destroy(); this.socket = undefined;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new MusicError("audio_engine", "The audio engine disconnected. Saved requests were retained.")); }
    this.pending.clear(); this.events.emit("lost"); this.onLost();
  }
  private async ensure(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try { await this.starting; } finally { this.starting = undefined; }
  }
  private async start() {
    if (this.child) await this.close();
    try { unlinkSync(this.ipc); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const child = spawn(this.executable, ["--no-config", "--idle=yes", "--no-terminal", "--no-video", "--ytdl=no", "--cache-on-disk=no", "--resume-playback=no", "--save-watch-history=no", "--cookies=no", `--input-ipc-server=${this.ipc}`], { stdio: "ignore" });
    this.child = child;
    let failed = false;
    child.on("error", () => { failed = true; });
    child.on("exit", () => { if (this.child === child) { this.child = undefined; this.disconnected(); } });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !failed && child.exitCode === null) {
      try {
        const socket = await new Promise<Socket>((resolve, reject) => {
          const s = createConnection(this.ipc);
          s.once("error", e => { s.destroy(); reject(e); });
          s.once("connect", () => resolve(s));
        });
        this.socket = socket;
        let buffer = "";
        socket.on("error", () => {});
        socket.on("close", () => { if (this.socket === socket) this.disconnected(); });
        socket.on("data", chunk => {
          buffer += chunk.toString();
          if (buffer.length > 2 * 1024 * 1024) { socket.destroy(); return; }
          const lines = buffer.split("\n"); buffer = lines.pop() || "";
          for (const line of lines) {
            try {
              const m = JSON.parse(line);
              if (m.request_id !== undefined) {
                const p = this.pending.get(m.request_id);
                if (p) { this.pending.delete(m.request_id); clearTimeout(p.timer); m.error && m.error !== "success" ? p.reject(new MusicError("mpv_property", "Audio command was not available.")) : p.resolve(m.data); }
              }
              if (m.event === "file-loaded") this.events.emit("loaded");
              if (m.event === "end-file") {
                this.events.emit("end", m.reason);
                if (!this.loading && ["eof", "error"].includes(m.reason)) this.onEnd(m.reason);
              }
            } catch { /* Ignore malformed unsolicited IPC records. */ }
          }
        });
        return;
      } catch { await sleep(50); }
    }
    await this.close();
    throw new MusicError("audio_engine", "mpv could not start. Check the music service and installed audio dependencies.");
  }
  private async command(...command: unknown[]): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) throw new MusicError("audio_engine", "The audio engine is not connected.");
    const request_id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(request_id); reject(new MusicError("audio_timeout", "The audio engine did not respond.")); }, 3000);
      this.pending.set(request_id, { resolve, reject, timer });
      this.socket!.write(JSON.stringify({ command, request_id }) + "\n");
    });
  }
  private async get(property: string) {
    try { return await this.command("get_property", property); }
    catch (e) { if (e instanceof MusicError && e.code === "mpv_property") return null; throw e; }
  }
  async status(): Promise<Playback> {
    if (!this.socket || this.socket.destroyed) return { active: false, paused: false, buffering: false, position: 0, duration: 0, volume: 0, muted: false, output: null };
    const [idle, paused, buffering, position, duration, volume, muted, output, audio, devices, selected] = await Promise.all(["idle-active", "pause", "paused-for-cache", "time-pos", "duration", "volume", "mute", "current-ao", "audio-out-params", "audio-device-list", "audio-device"].map(p => this.get(p)));
    const device = Array.isArray(devices) ? devices.find(d => d.name === selected) : undefined;
    const available = this.speaker ? Array.isArray(devices) && devices.some(d => d.description === this.speaker && /^(pipewire|pulse)\//.test(d.name)) : null;
    return { device: this.speaker || device?.description || null, deviceAvailable: available, active: idle === false && !!audio && typeof output === "string" && output !== "null", paused: paused === true, buffering: buffering === true, position: Number(position) || 0, duration: Number(duration) || 0, volume: Number(volume) || 0, muted: muted === true, output: typeof output === "string" ? output : null };
  }
  async load(stream: { url: string; headers: Record<string, string> }, signal: AbortSignal, position = 0, paused = false) {
    await this.ensure();
    if (signal.aborted) throw new MusicError("cancelled", "Music request cancelled.");
    if (this.speaker) {
      const devices = await this.get("audio-device-list");
      const match = Array.isArray(devices) ? devices.find(d => d.description === this.speaker && /^pipewire\//.test(d.name)) || devices.find(d => d.description === this.speaker && /^pulse\//.test(d.name)) : undefined;
      if (!match) throw new MusicError("speaker_disconnected", "The configured speaker is not connected. Connect it, then resume; the queue was retained.");
      await this.command("set_property", "audio-device", match.name);
    }
    this.loading = true;
    let dispose = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      const finish = (e?: Error) => { dispose(); e ? reject(e) : resolve(); };
      const loaded = () => finish();
      const ended = (reason: string) => { if (reason === "error") finish(new MusicError("audio_load", "The selected audio stream failed to load. Queued requests were retained.")); };
      const lost = () => finish(new MusicError("audio_engine", "The audio engine stopped unexpectedly."));
      const abort = () => finish(new MusicError("cancelled", "Music request cancelled."));
      const timer = setTimeout(() => finish(new MusicError("audio_load_timeout", "Audio loading timed out. Queued requests were retained.")), 20_000);
      dispose = () => { clearTimeout(timer); this.events.off("loaded", loaded); this.events.off("end", ended); this.events.off("lost", lost); signal.removeEventListener("abort", abort); };
      this.events.on("loaded", loaded); this.events.on("end", ended); this.events.on("lost", lost); signal.addEventListener("abort", abort, { once: true });
    });
    void ready.catch(() => {});
    try {
      await this.command("set_property", "http-header-fields", Object.entries(stream.headers).map(([k, v]) => `${k}: ${v}`));
      await this.command("set_property", "pause", paused);
      await this.command("loadfile", stream.url, "replace", -1, { start: String(Math.max(0, position)) });
      await ready;
      // Verify active audio and advancing time, not merely acceptance of loadfile.
      const deadline = Date.now() + 6000;
      let first: number | undefined;
      while (Date.now() < deadline) {
        if (signal.aborted) throw new MusicError("cancelled", "Music request cancelled.");
        const state = await this.status();
        if (paused && state.active && state.paused) return;
        if (state.active && !state.paused && !state.buffering) {
          if (first !== undefined && state.position > first + 0.02) return;
          first ??= state.position;
        }
        await sleep(150);
      }
      throw new MusicError("no_audio_output", "The track loaded, but advancing audio output could not be confirmed. Check the speaker connection.");
    } catch (e) {
      await this.command("stop").catch(() => {});
      throw e;
    } finally { dispose(); this.loading = false; }
  }
  async pause(value: boolean) { await this.ensure(); await this.command("set_property", "pause", value); }
  async volume(value: number) { await this.ensure(); await this.command("set_property", "volume", value); }
  async stop() { if (this.socket && !this.socket.destroyed) await this.command("stop"); }
  async close() {
    const child = this.child; this.child = undefined;
    this.disconnected();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise<void>(resolve => child.once("exit", () => resolve())), sleep(1000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    try { unlinkSync(this.ipc); } catch {}
  }
}
