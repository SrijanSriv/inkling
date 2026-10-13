import http from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { config, getUsers } from "./config.js";
import { transcribe } from "./voice.js";
import { queueVoice, VoiceInputError, voiceErrorText } from "./voice-intake.js";
import { log } from "./log.js";

const RATE = 16000, MAX_BYTES = RATE * 2 * 20;
const PAGE = readFileSync(new URL("../assets/microphone.html", import.meta.url), "utf8");
type Phase = "idle" | "starting" | "listening" | "transcribing" | "sending" | "sent" | "cancelled" | "error";
type Status = { phase: Phase; detail: string; seconds: number; level: number; signal: string; transcript?: string; id?: string };
type Job = { id: string; owner: string; recorder: ChildProcessWithoutNullStreams; chunks: Buffer[]; bytes: number;
  samples: number; sum: number; energy: number; clipped: number; lastFrame: number; start: number;
  closing: boolean; cancelled: boolean; deadline: NodeJS.Timeout; watchdog: NodeJS.Timeout };
export type MicDependencies = {
  available: () => boolean;
  send: (owner: string, text: string, id: string) => Promise<void>;
  record?: () => ChildProcessWithoutNullStreams;
  transcribe?: (audio: Buffer) => Promise<string>;
};
export const microphoneEnabled = () => !!config.micSource && !!config.micControlUrl && !!config.whisperUrl && !!config.whisperSecret;

/** PCM gets one ordinary WAV header. No temporary recording or shell command is needed. */
export function microphoneWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Stage one is deliberately transcript-only. Room audio never enters the agent or confirms a draft. */
export class Microphone {
  private sessions = new Map<string, { owner: string; until: number }>();
  private job?: Job;
  private state: Status = { phase: "idle", detail: "Tap Listen, then speak. Tap Done when finished (20 seconds maximum).", seconds: 0, level: 0, signal: "not checked" };
  private expires = 0;
  private stateOwner?: string;
  private arrivals: number[] = [];
  constructor(private deps: MicDependencies) {}

  linkFor(owner: string): string {
    if (!getUsers().some(u => u.id === owner && u.owner)) throw new Error("Microphone controls are owner-private.");
    for (const [key, session] of this.sessions) if (session.owner === owner || session.until < Date.now()) this.sessions.delete(key);
    const token = randomBytes(24).toString("base64url");
    this.sessions.set(token, { owner, until: Date.now() + 30 * 60_000 });
    return `${config.micControlUrl}/#${token}`;
  }
  authorized(token: string): string | undefined {
    const session = this.sessions.get(token);
    if (!session || session.until < Date.now()) return;
    return getUsers().some(u => u.id === session.owner && u.owner) ? session.owner : undefined;
  }
  status(owner?: string): Status {
    if (owner && this.stateOwner && owner !== this.stateOwner) return { phase: "idle", detail: "Tap Listen for a new recording.", seconds: 0, level: 0, signal: "not checked" };
    if (!this.job && this.expires && Date.now() > this.expires) {
      this.state = { phase: "idle", detail: "Tap Listen for a new recording.", seconds: 0, level: 0, signal: "not checked" };
      this.expires = 0;
    }
    return { ...this.state };
  }
  private update(patch: Partial<Status>): void { this.state = { ...this.state, ...patch }; }

  control(owner: string, action: string): string {
    if (!getUsers().some(u => u.id === owner && u.owner)) throw new Error("Microphone controls are owner-private.");
    if (action === "listen") {
      if (!this.deps.available()) throw new Error("WhatsApp is unavailable. Try when the assistant reconnects.");
      if (this.job) throw new Error("A microphone request is already in progress. Wait or cancel it.");
      this.arrivals = this.arrivals.filter(at => Date.now() - at < 600_000);
      if (this.arrivals.length >= 12) throw new Error("Too many microphone requests. Try again in a few minutes.");
      this.arrivals.push(Date.now());
      this.begin(owner); return "Starting capture. Wait for Listening before speaking.";
    }
    const job = this.job;
    if (!job || job.owner !== owner) throw new Error("There is no microphone request in progress.");
    if (action === "cancel") {
      job.cancelled = true;
      if (!job.closing) this.stop(job, "cancel");
      else this.update({ detail: "Cancelled. Waiting for the current service call to finish; no new result will be sent." });
      return "Cancelled.";
    }
    if (action === "done" && !job.closing) { this.stop(job, "done"); return "Finishing capture."; }
    throw new Error("That control is unavailable at this stage.");
  }

  private begin(owner: string): void {
    const recorder = this.deps.record?.() ?? spawn("pw-record", ["--raw", "--target", config.micSource!, "--rate", String(RATE), "--channels", "1", "--format", "s16", "-"], { stdio: "pipe" });
    const job = { id: randomUUID(), owner, recorder, chunks: [], bytes: 0, samples: 0, sum: 0, energy: 0, clipped: 0,
      start: Date.now(), lastFrame: Date.now(), closing: false, cancelled: false } as unknown as Job;
    this.job = job;
    this.stateOwner = owner;
    this.state = { phase: "starting", detail: "Opening the Pi microphone…", seconds: 0, level: 0, signal: "not checked", id: job.id };
    this.expires = 0;
    recorder.stderr.resume(); // Device diagnostics stay out of chat and content logs.
    let tail: Buffer = Buffer.alloc(0);
    recorder.stdout.on("data", (data: Buffer) => {
      if (job.closing) return;
      const combined = tail.length ? Buffer.concat([tail, data]) : data;
      const length = combined.length - combined.length % 2;
      tail = combined.subarray(length);
      if (!length) return;
      if (job.bytes + length > MAX_BYTES) return this.stop(job, "limit");
      const pcm = Buffer.from(combined.subarray(0, length));
      job.chunks.push(pcm); job.bytes += pcm.length; job.lastFrame = Date.now();
      let energy = 0;
      for (let i = 0; i < pcm.length; i += 2) {
        const value = pcm.readInt16LE(i);
        job.samples++; job.sum += value; job.energy += value * value; energy += value * value;
        job.clipped += Number(Math.abs(value) >= 32700);
      }
      const rms = Math.sqrt(energy / (pcm.length / 2));
      this.update({ phase: "listening", seconds: job.bytes / RATE / 2, level: Math.min(1, rms / 3000),
        signal: rms === 0 ? "no signal" : "signal arriving",
        detail: rms === 0 ? "Listening, but the input is zero. Check transmitter power, mute and pairing." : "Listening. Speak, then tap Done. Signal does not prove speech was understood." });
    });
    recorder.once("error", () => this.stop(job, "device"));
    recorder.once("close", () => { if (!job.closing) this.stop(job, "device"); });
    job.deadline = setTimeout(() => this.stop(job, "limit"), 22_000);
    job.watchdog = setInterval(() => { if (Date.now() - job.lastFrame > 2500) this.stop(job, "device"); }, 500);
  }

  private stop(job: Job, reason: "done" | "cancel" | "limit" | "device"): void {
    if (job.closing) return;
    job.closing = true;
    clearTimeout(job.deadline); clearInterval(job.watchdog);
    job.recorder.kill("SIGTERM");
    const kill = setTimeout(() => job.recorder.kill("SIGKILL"), 1500); kill.unref();
    job.recorder.once("close", () => clearTimeout(kill));
    if (reason !== "done") {
      job.chunks = [];
      this.update({ phase: reason === "cancel" ? "cancelled" : "error", level: 0,
        detail: reason === "cancel" ? "Cancelled. Nothing transcribed or sent." : reason === "limit"
          ? "The 20-second limit was reached. Nothing sent. Try a shorter recording and tap Done."
          : "Microphone capture stopped or stalled. Nothing transcribed. Check the receiver and retry." });
      this.job = undefined; this.expires = Date.now() + 60_000; return;
    }
    const rms = Math.sqrt(job.energy / Math.max(1, job.samples));
    const variation = job.energy / Math.max(1, job.samples) - (job.sum / Math.max(1, job.samples)) ** 2;
    if (job.bytes < RATE * 2 * .3 || rms < 25 || variation < 1 || job.clipped / Math.max(1, job.samples) > .01) {
      job.chunks = [];
      this.update({ phase: "error", level: 0, detail: "The recording was too short, silent, constant or badly clipped. Nothing transcribed. Check the mic and try again." });
      this.job = undefined; this.expires = Date.now() + 60_000; return;
    }
    const audio = microphoneWav(Buffer.concat(job.chunks)); job.chunks = [];
    this.update({ phase: "transcribing", level: 0, detail: "Transcribing with the existing speech service…" });
    void this.finish(job, audio);
  }

  private async finish(job: Job, audio: Buffer): Promise<void> {
    try {
      const text = await queueVoice(`microphone-${job.owner}`, () => this.deps.transcribe?.(audio) ?? transcribe(audio, "audio/wav"));
      if (job.cancelled) return;
      if (!getUsers().some(u => u.id === job.owner && u.owner) || !this.deps.available()) throw new VoiceInputError("unavailable");
      this.update({ phase: "sending", transcript: text, detail: "Transcript ready. Sending it to your private WhatsApp…" });
      // Only a later manual request can retry. An uncertain send must not duplicate a notice.
      await this.deps.send(job.owner, `Mic check · I heard:\n${text}\n\nTranscript only: I haven't acted on these words.`, `INKMIC${job.id.replaceAll("-", "")}`);
      this.update({ phase: "sent", detail: "Transcript sent to your private WhatsApp. Check it matches what you said." });
    } catch (error) {
      this.update({ phase: "error", detail: this.state.phase === "sending"
        ? "WhatsApp delivery wasn't confirmed. Check your chat before retrying."
        : error instanceof VoiceInputError ? voiceErrorText(error.kind) : "Transcription failed. Nothing was acted on. Please retry." });
      log.warn("microphone request failed");
    } finally {
      if (job.cancelled) this.update({ phase: "cancelled", transcript: undefined, detail: "Cancelled. A send already in progress may still arrive; no retry will be made." });
      this.job = undefined; this.expires = Date.now() + 60_000;
    }
  }

  handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const reply = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
      res.end(type === "text/html" ? String(body) : JSON.stringify(body));
    };
    const pathname = (req.url || "").split("?")[0];
    if (req.method === "GET" && pathname === "/") return reply(200, PAGE, "text/html");
    const owner = this.authorized(req.headers.authorization?.replace(/^Bearer /, "") || "");
    if (!owner) return reply(403, { error: "Link expired or unavailable. Send /mic in your private WhatsApp chat for a fresh link." });
    if (req.method === "GET" && pathname === "/status") return reply(200, this.status(owner));
    if (req.method !== "POST" || !["/listen", "/done", "/cancel"].includes(pathname)) return reply(404, { error: "Not found" });
    // Bearer auth prevents cross-site forms; origin checks also reject accidental cross-site scripts.
    if (req.headers.origin && req.headers.origin !== new URL(config.micControlUrl!).origin) return reply(403, { error: "Wrong origin" });
    try { return reply(200, { message: this.control(owner, pathname.slice(1)) }); }
    catch (error) { return reply(409, { error: error instanceof Error ? error.message : "Control unavailable" }); }
  };
  close(): void { if (this.job) { this.job.cancelled = true; if (!this.job.closing) this.stop(this.job, "cancel"); } this.sessions.clear(); }
}

let microphone: Microphone | undefined;
export function microphoneLink(owner: string): string | undefined { return microphone?.linkFor(owner); }
export function startMicrophone(deps: MicDependencies): void {
  if (!microphoneEnabled()) return;
  try {
    const address = new URL(config.micControlUrl!);
    if (!/^https?:$/.test(address.protocol) || address.username || address.password || address.pathname !== "/") throw new Error("invalid microphone control address");
    microphone = new Microphone(deps);
    const controller = microphone;
    const server = http.createServer((req, res) => {
      void controller.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); log.warn("microphone control failed"); });
    });
    server.requestTimeout = 5000; server.headersTimeout = 5000;
    server.on("error", () => { microphone?.close(); microphone = undefined; log.warn("microphone controls unavailable"); });
    server.listen(config.micPort, config.micHost);
    process.once("exit", () => microphone?.close());
  } catch { microphone = undefined; log.warn("microphone controls unavailable"); }
}
