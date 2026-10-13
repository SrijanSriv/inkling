import http from "node:http";
import https from "node:https";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { config, getUsers } from "./config.js";
import { transcribe } from "./voice.js";
import { queueVoice, VoiceInputError, voiceErrorText } from "./voice-intake.js";
import { log } from "./log.js";
import { reviewMicrophone } from "./microphone-review.js";
import { transcribeMicrophone } from "./microphone-transcription.js";

const RATE = 16000, MAX_BYTES = RATE * 2 * 20;
const PAGE = readFileSync(new URL("../assets/microphone.html", import.meta.url), "utf8");
type Phase = "idle" | "starting" | "listening" | "transcribing" | "comparing" | "sending" | "sent" | "cancelled" | "error";
type Reply = { text: string; elapsedMs: number; at: number; id: string; delivered: boolean };
type Status = { latestReply?: Reply; busy?: boolean; phase: Phase; detail: string; seconds: number; level: number; signal: string; transcript?: string; id?: string; recordingExpiresAt?: number; canCompare?: boolean; comparison?: string; conversation?: boolean };
type Job = { id: string; owner: string; recorder?: ChildProcessWithoutNullStreams; device?: boolean; uploading?: boolean; submittedAt?: number; chunks: Buffer[]; bytes: number;
  samples: number; sum: number; energy: number; clipped: number; lastFrame: number; start: number;
  closing: boolean; cancelled: boolean; abort: AbortController; holdUntil?: number; deadline: NodeJS.Timeout; watchdog: NodeJS.Timeout };
export type MicDependencies = {
  available: () => boolean;
  send: (owner: string, text: string, id: string) => Promise<void>;
  record?: () => ChildProcessWithoutNullStreams;
  transcribe?: (audio: Buffer) => Promise<string>;
  compare?: (audio: Buffer, signal: AbortSignal) => Promise<unknown>;
  decode?: (audio: Buffer, signal: AbortSignal) => Promise<{ text: string; warning?: string }>;
  converse?: (owner: string, input: { id: string; text: string; warning?: string; doneAt: number; transcriptionMs: number }) => Promise<void>;
};
const Comparison = z.object({ results: z.array(z.object({ model: z.string().min(1).max(60), text: z.string().max(16000).optional(),
  seconds: z.number().nonnegative().max(200).optional(), error: z.string().max(200).optional(), warning: z.string().max(200).optional() })).min(2).max(3) });

/** Trusted configuration supplies argv, never a model or HTTP caller. Audio goes only through stdin. */
export async function compareMicrophone(audio: Buffer, signal: AbortSignal): Promise<unknown> {
  const argv = z.array(z.string().min(1).max(4096)).min(1).max(30).parse(JSON.parse(config.micCompareCommand!));
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "pipe", signal });
    const output: Buffer[] = []; let bytes = 0;
    const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Microphone comparison timed out")); }, 195_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64_000) { child.kill("SIGTERM"); reject(new Error("Comparison output too large")); } else output.push(chunk); });
    child.stderr.resume(); child.stdin.on("error", () => {}); child.stdin.end(audio);
    child.once("error", () => { clearTimeout(timeout); reject(new Error("Microphone comparison unavailable")); });
    child.once("close", code => { clearTimeout(timeout); try { if (code !== 0) throw new Error(); resolve(JSON.parse(Buffer.concat(output).toString())); } catch { reject(new Error("Microphone comparison failed")); } });
  });
}
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

/** Manual captures and replies stay in the registered person's private chat. Optional conversation mode never confirms outgoing drafts. */
export class Microphone {
  private sessions = new Map<string, { owner: string; until: number }>();
  private job?: Job;
  private state: Status = { phase: "idle", detail: "Hold the circle, wait for Listening, then speak. Release to send (20 seconds maximum).", seconds: 0, level: 0, signal: "not checked" };
  private expires = 0;
  private stateOwner?: string;
  private arrivals = new Map<string, number[]>();
  private replies = new Map<string, Reply>();
  private awaiting = new Map<string, { user: string; until: number }>();
  private recording?: { owner: string; id: string; audio: Buffer; until: number; timer: NodeJS.Timeout };
  private comparing?: { owner: string; cancelled: boolean; abort: AbortController };
  private comparisonArrivals: number[] = [];
  constructor(private deps: MicDependencies) {}

  linkFor(owner: string): string {
    if (!getUsers().some(u => u.id === owner)) throw new Error("Microphone controls are available in registered private chats.");
    for (const [key, session] of this.sessions) if (session.owner === owner || session.until < Date.now()) this.sessions.delete(key);
    this.prune();
    const token = randomBytes(24).toString("base64url");
    this.sessions.set(token, { owner, until: Date.now() + 30 * 60_000 });
    return `${config.micControlUrl}/#${token}`;
  }
  authorized(token: string): string | undefined {
    const session = this.sessions.get(token);
    if (!session || session.until < Date.now()) return;
    return getUsers().some(u => u.id === session.owner) ? session.owner : undefined;
  }
  private prune(): void {
    const now = Date.now();
    for (const [key, value] of this.replies) if (now-value.at > 30*60_000) this.replies.delete(key);
    for (const [key, value] of this.awaiting) if (value.until < now) this.awaiting.delete(key);
    for (const [key, times] of this.arrivals) if (!times.some(at=>now-at<600_000)) this.arrivals.delete(key);
  }
  completed(user: string, messageId: string, text: string, elapsedMs: number, delivered: boolean): void {
    this.prune();
    const pending = this.awaiting.get(messageId);
    if (!pending || pending.user !== user || !getUsers().some(u=>u.id===user)) return;
    this.awaiting.delete(messageId);
    this.replies.set(user, { text: text.slice(0,32000), elapsedMs: Math.max(0,elapsedMs), at: Date.now(), id: messageId, delivered });
    if (this.stateOwner === user) this.update({ detail: delivered ? "Reply sent to WhatsApp and shown below." : "Reply ready below, but WhatsApp delivery was not confirmed." });
  }
  status(owner?: string): Status {
    this.prune();
    const latestReply = owner ? this.replies.get(owner) : undefined;
    if (owner && this.stateOwner && owner !== this.stateOwner) return { phase: "idle", detail: this.job || this.comparing ? "The shared microphone service is busy. Try again shortly." : "Hold the circle for a new recording.", seconds: 0, level: 0, signal: "not checked", busy: !!this.job || !!this.comparing, latestReply, conversation: config.micConversation };
    if (!this.job && !this.comparing && this.expires && Date.now() > this.expires) {
      this.state = { phase: "idle", detail: "Hold the circle for a new recording.", seconds: 0, level: 0, signal: "not checked" };
      this.expires = 0;
    }
    const valid = !!this.recording && Date.now() < this.recording.until;
    return { ...this.state, latestReply, conversation: config.micConversation, recordingExpiresAt: valid ? this.recording!.until : undefined,
      canCompare: valid && !!this.deps.compare && !this.job && !this.comparing };
  }
  private update(patch: Partial<Status>): void { this.state = { ...this.state, ...patch }; }
  private clearRecording(): void {
    if (this.recording) { clearTimeout(this.recording.timer); this.recording.audio.fill(0); this.recording = undefined; }
  }

  control(owner: string, action: string, id?: string, device = false): string {
    if (!getUsers().some(u => u.id === owner)) throw new Error("Microphone controls are available in registered private chats.");
    if (action === "compare") {
      const recording = this.recording;
      if (!this.deps.compare || !recording || recording.owner !== owner || Date.now() >= recording.until) throw new Error("Make a new recording, then compare within one minute of the transcript arriving (three minutes maximum after Done).");
      if (this.job || this.comparing) throw new Error("Wait for the current microphone request to finish.");
      this.comparisonArrivals = this.comparisonArrivals.filter(at => Date.now() - at < 600_000);
      if (this.comparisonArrivals.length >= 4) throw new Error("Comparison limit reached. Try again in a few minutes.");
      this.comparisonArrivals.push(Date.now());
      const comparison = { owner, cancelled: false, abort: new AbortController() }; this.comparing = comparison;
      this.update({ phase: "comparing", detail: "Comparing the same captured audio. No expected words are supplied; this may take a minute.", comparison: undefined });
      void this.compareRecording(owner, Buffer.from(recording.audio), comparison); return "Comparison started.";
    }
    if (action === "cancel" && this.comparing) {
      if (this.comparing.owner!==owner) throw new Error("There is no comparison in progress for you.");
      this.comparing.cancelled = true; this.comparing.abort.abort(); this.clearRecording();
      this.update({ detail: "Cancelling comparison. No new result will be sent." }); return "Cancelling comparison.";
    }
    if (action === "listen" || action === "hold") {
      if (!this.deps.available()) throw new Error("WhatsApp is unavailable. Try when the assistant reconnects.");
      if (this.job || this.comparing) throw new Error("A microphone request is already in progress. Wait or cancel it.");
      this.prune();
      const arrivals = (this.arrivals.get(owner) || []).filter(at => Date.now()-at<600_000);
      if (arrivals.length >= 12) throw new Error("Too many microphone requests. Try again in a few minutes.");
      arrivals.push(Date.now()); this.arrivals.set(owner,arrivals);
      this.begin(owner, action === "hold", device); return "Starting capture. Wait for Listening before speaking.";
    }
    const job = this.job;
    if (!job || job.owner !== owner) throw new Error("There is no microphone request in progress.");
    if (id && id !== job.id) throw new Error("That recording is no longer active.");
    if (job.holdUntil && !job.closing && Date.now() > job.holdUntil) {
      this.stop(job, "cancel");
      throw new Error("The hold expired. Nothing was submitted.");
    }
    if (action === "held") {
      if (!job.holdUntil || job.closing || id !== job.id) throw new Error("That held recording is no longer active.");
      job.holdUntil = Date.now() + 3000;
      return "Hold continued.";
    }
    if (action === "done" && job.holdUntil && id !== job.id) throw new Error("Release must match the held recording.");
    if (action === "cancel") {
      job.cancelled = true;
      job.abort.abort();
      this.clearRecording();
      if (!job.closing) this.stop(job, "cancel");
      else this.update({ detail: "Cancelled. Waiting for the current service call to finish; no new result will be sent." });
      return "Cancelled.";
    }
    if (action === "done" && job.device && !job.closing && !job.uploading) {
      job.uploading = true; job.submittedAt = Date.now(); job.holdUntil = undefined;
      clearTimeout(job.deadline); job.deadline = setTimeout(()=>this.stop(job,"device"),15_000);
      this.update({phase:"transcribing",detail:"Receiving your device recording…"});
      return "Receiving recording.";
    }
    if (action === "done" && !job.closing && !job.device) { this.stop(job, "done"); return "Finishing capture."; }
    throw new Error("That control is unavailable at this stage.");
  }

  private async compareRecording(owner: string, audio: Buffer, comparison: { cancelled: boolean; abort: AbortController }): Promise<void> {
    try {
      const result = Comparison.parse(await this.deps.compare!(audio, comparison.abort.signal));
      if (comparison.cancelled) return;
      if (!getUsers().some(u => u.id === owner) || !this.deps.available()) throw new Error("Comparison delivery unavailable");
      const text = result.results.map(r => `${r.model}${r.seconds !== undefined ? ` (${r.seconds.toFixed(1)} seconds)` : ""}:\n${r.text?.trim() || "No usable result"}${r.warning ? `\nCheck: ${r.warning}` : ""}`).join("\n\n");
      this.update({ phase: "sending", comparison: text, detail: "Sending the comparison to your private WhatsApp…" });
      await this.deps.send(owner, `Mic comparison · Same recording\n\n${text}\n\nCompare with what you actually said. Neither result is automatically correct. Nothing was acted on.`, `INKMICCMP${randomUUID().replaceAll("-", "")}`);
      this.update({ phase: "sent", detail: "Comparison sent. Check which words each recognizer got right or wrong." });
    } catch {
      this.update({ phase: comparison.cancelled ? "cancelled" : "error", detail: comparison.cancelled ? "Comparison cancelled. A send already started may still arrive."
        : this.state.phase === "sending" ? "Comparison delivery wasn't confirmed. Check your chat before retrying."
        : "Comparison failed. The ordinary speech service is unchanged. Try a new recording." });
      log.warn("microphone comparison incomplete");
    } finally {
      if (comparison.cancelled) this.update({ phase: "cancelled", comparison: undefined, detail: "Comparison cancelled. A send already started may still arrive; no retry will be made." });
      audio.fill(0); this.comparing = undefined; this.expires = Date.now() + 60_000;
    }
  }

  private begin(owner: string, held = false, device = false): void {
    this.clearRecording();
    const recorder = device ? undefined : this.deps.record?.() ?? spawn("pw-record", ["--raw", "--target", config.micSource!, "--rate", String(RATE), "--channels", "1", "--format", "s16", "-"], { stdio: "pipe" });
    const job = { id: randomUUID(), owner, recorder, device, chunks: [], bytes: 0, samples: 0, sum: 0, energy: 0, clipped: 0,
      start: Date.now(), lastFrame: Date.now(), closing: false, cancelled: false, abort: new AbortController(),
      holdUntil: held ? Date.now() + 3000 : undefined } as unknown as Job;
    this.job = job;
    this.stateOwner = owner;
    this.state = { phase: "starting", detail: device ? "Opening your device microphone…" : "Opening the Pi microphone…", seconds: 0, level: 0, signal: "not checked", id: job.id };
    this.expires = 0;
    recorder?.stderr.resume(); // Device diagnostics stay out of chat and content logs.
    let tail: Buffer = Buffer.alloc(0);
    recorder?.stdout.on("data", (data: Buffer) => {
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
        detail: rms === 0 ? "Listening, but the input is zero. Check transmitter power, mute and pairing." : "Listening. Speak, then release the circle to send. Signal does not prove speech was understood." });
    });
    recorder?.once("error", () => this.stop(job, "device"));
    recorder?.once("close", () => { if (!job.closing) this.stop(job, "device"); });
    job.deadline = setTimeout(() => this.stop(job, "limit"), 22_000);
    job.watchdog = setInterval(() => {
      if (job.holdUntil && Date.now() > job.holdUntil) this.stop(job, "cancel");
      else if (!job.device && Date.now() - job.lastFrame > 2500) this.stop(job, "device");
    }, 500);
  }

  private stop(job: Job, reason: "done" | "cancel" | "limit" | "device"): void {
    if (job.closing) return;
    job.closing = true;
    clearTimeout(job.deadline); clearInterval(job.watchdog);
    job.recorder?.kill("SIGTERM");
    const kill = setTimeout(() => job.recorder?.kill("SIGKILL"), 1500); kill.unref();
    job.recorder?.once("close", () => clearTimeout(kill));
    if (reason !== "done") {
      job.chunks = [];
      this.update({ phase: reason === "cancel" ? "cancelled" : "error", level: 0,
        detail: reason === "cancel" ? "Cancelled. Nothing transcribed or sent." : reason === "limit"
          ? "The 20-second limit was reached. Nothing sent. Try a shorter recording and release the circle to send."
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
    // Independent copy: expiry must not zero a request still being decoded by the speech gateway.
    this.recording = { owner: job.owner, id: job.id, audio: Buffer.from(audio), until: Date.now() + 180_000,
      timer: setTimeout(() => this.clearRecording(), 180_000) };
    this.recording.timer.unref();
    this.update({ phase: "transcribing", level: 0, detail: config.micConversation ? `Transcribing your request for ${config.name}…` : config.micReviewModel
      ? "Transcribing and checking a second recognizer. This is a draft, not a verified instruction…"
      : "Transcribing with the existing speech service…" });
    void this.finish(job, audio);
  }

  private async finish(job: Job, audio: Buffer): Promise<void> {
    const doneAt = job.submittedAt ?? Date.now();
    try {
      const reviewed = await queueVoice(`microphone-${job.owner}`, async () => {
        if (config.micConversation) return (this.deps.decode ?? transcribeMicrophone)(audio, job.abort.signal);
        if (config.micReviewModel) {
          if (!config.micReviewReference || !this.deps.compare) throw new VoiceInputError("unavailable");
          const result = Comparison.parse(await this.deps.compare(audio, job.abort.signal));
          return reviewMicrophone(result.results, config.micReviewModel, config.micReviewReference);
        }
        return { text: await (this.deps.transcribe?.(audio) ?? transcribe(audio, "audio/wav")), clarification: undefined };
      });
      if (job.cancelled) return;
      if (!getUsers().some(u => u.id === job.owner ) || !this.deps.available()) throw new VoiceInputError("unavailable");
      const text = reviewed.text;
      if (config.micConversation) {
        if (!this.deps.converse) throw new VoiceInputError("unavailable");
        const warning = "warning" in reviewed ? reviewed.warning : undefined;
        this.update({ phase: "sending", transcript: text, detail: `Passing your transcript to ${config.name}…` });
        this.awaiting.set(`INKMIC${job.id.replaceAll("-", "")}`, {user:job.owner,until:Date.now()+10*60_000});
        await this.deps.converse(job.owner, { id: job.id, text, warning, doneAt, transcriptionMs: Date.now()-doneAt });
        this.update({ phase: "sent", detail: `Request queued for ${config.name}. A text reply will arrive in your private WhatsApp.` });
        return;
      }
      const clarification = "clarification" in reviewed ? reviewed.clarification : undefined;
      this.update({ phase: "sending", transcript: [text, clarification].filter(Boolean).join("\n\n"), detail: "Transcript ready for review. Sending it to your private WhatsApp…" });
      // Only a later manual request can retry. An uncertain send must not duplicate a notice.
      await this.deps.send(job.owner, `Mic check · Please check what I heard:\n${text}${clarification ? `\n\n${clarification}` : ""}\n\nTranscript only: I haven't acted on these words.`, `INKMIC${job.id.replaceAll("-", "")}`);
      this.update({ phase: "sent", detail: "Transcript sent to your private WhatsApp. Check it matches what you said." });
    } catch (error) {
      this.update({ phase: "error", detail: this.state.phase === "sending"
        ? "WhatsApp delivery wasn't confirmed. Check your chat before retrying."
        : error instanceof VoiceInputError ? voiceErrorText(error.kind) : "Transcription failed. Nothing was acted on. Please retry." });
      log.warn("microphone request failed");
    } finally {
      audio.fill(0);
      if (job.cancelled) this.update({ phase: "cancelled", transcript: undefined, detail: "Cancelled. A send already in progress may still arrive; no retry will be made." });
      // Service latency must not consume the entire manual comparison window. Never extend the hard cap.
      const recording = this.recording;
      if (recording?.id === job.id) {
        clearTimeout(recording.timer);
        recording.until = Math.min(recording.until, Date.now() + 60_000);
        recording.timer = setTimeout(() => this.clearRecording(), Math.max(0, recording.until - Date.now()));
        recording.timer.unref();
      }
      this.job = undefined; this.expires = Date.now() + 60_000;
    }
  }

  async upload(owner: string, id: string, audio: Buffer): Promise<void> {
    const job = this.job;
    if (!job || job.owner !== owner || job.id !== id || !job.device || !job.uploading || job.closing || job.cancelled
      || !getUsers().some(u=>u.id===owner)) throw new Error("This recording is no longer active.");
    if (audio.length < 44 || audio.length > MAX_BYTES+44 || audio.toString("ascii",0,4)!=="RIFF"
      || audio.toString("ascii",8,16)!=="WAVEfmt " || audio.readUInt32LE(4)!==audio.length-8
      || audio.readUInt32LE(16)!==16 || audio.readUInt16LE(20)!==1 || audio.readUInt16LE(22)!==1
      || audio.readUInt32LE(24)!==RATE || audio.readUInt32LE(28)!==RATE*2 || audio.readUInt16LE(32)!==2
      || audio.readUInt16LE(34)!==16 || audio.toString("ascii",36,40)!=="data"
      || audio.readUInt32LE(40)!==audio.length-44 || (audio.length-44)%2) throw new Error("Unsupported microphone recording.");
    const pcm = Buffer.from(audio.subarray(44));
    job.chunks=[pcm]; job.bytes=pcm.length;
    for (let i=0;i<pcm.length;i+=2) {
      const value=pcm.readInt16LE(i); job.samples++;job.sum+=value;job.energy+=value*value;
      job.clipped+=Number(Math.abs(value)>=32700);
    }
    this.update({seconds:pcm.length/RATE/2});
    this.stop(job,"done");
  }

  handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const reply = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
      res.end(Buffer.isBuffer(body) ? body : type === "text/html" ? String(body) : JSON.stringify(body));
    };
    const url = new URL(req.url || "/", "http://localhost"), pathname = url.pathname;
    if (req.method === "GET" && pathname === "/") return reply(200, PAGE, "text/html");
    if (req.method === "GET" && ["/microphone-device.js","/microphone-recorder.js"].includes(pathname)) {
      return reply(200,readFileSync(new URL(`../assets${pathname}`,import.meta.url)),"text/javascript");
    }
    const owner = this.authorized(req.headers.authorization?.replace(/^Bearer /, "") || "");
    if (!owner) return reply(403, { error: "Link expired or unavailable. Send /mic in your private WhatsApp chat for a fresh link." });
    if (req.method === "GET" && pathname === "/status") return reply(200, this.status(owner));
    if (req.method === "GET" && pathname === "/audio") {
      const recording = this.recording;
      if (!recording || recording.owner !== owner || recording.id !== url.searchParams.get("id") || Date.now() >= recording.until) return reply(410, { error: "Recording expired or unavailable. Make a new short test." });
      return reply(200, recording.audio, "audio/wav");
    }
    if (req.method === "POST" && pathname === "/input") {
      if (req.headers.origin && req.headers.origin !== new URL(config.micControlUrl!).origin) return reply(403,{error:"Wrong origin"});
      const job=this.job, id=url.searchParams.get("id");
      if (!job || job.owner!==owner || job.id!==id || !job.device || !job.uploading || job.closing) return reply(409,{error:"Recording unavailable"});
      const size=Number(req.headers["content-length"]);
      if (req.headers["transfer-encoding"] || !Number.isInteger(size) || size<44 || size>MAX_BYTES+44
        || req.headers["content-type"]!=="audio/wav") return reply(413,{error:"Invalid recording size or format"});
      const chunks:Buffer[]=[]; let bytes=0;
      try {
        for await (const chunk of req) { bytes+=chunk.length; if (bytes>size) throw new Error("Recording too large"); chunks.push(chunk); }
        if (bytes!==size) throw new Error("Incomplete recording");
        const audio=Buffer.concat(chunks);
        try { await this.upload(owner,id!,audio); } finally { audio.fill(0); }
        return reply(200,{message:"Recording submitted."});
      } catch { if (this.job===job && !job.closing) this.stop(job,"cancel"); return reply(409,{error:"Recording was interrupted or invalid. Try again."}); }
    }
    if (req.method !== "POST" || !["/listen", "/hold", "/held", "/done", "/cancel", "/compare"].includes(pathname)) return reply(404, { error: "Not found" });
    // Bearer auth prevents cross-site forms; origin checks also reject accidental cross-site scripts.
    if (req.headers.origin && req.headers.origin !== new URL(config.micControlUrl!).origin) return reply(403, { error: "Wrong origin" });
    try { return reply(200, { message: this.control(owner, pathname.slice(1), url.searchParams.get("id") || undefined, url.searchParams.get("source")==="device"),
      ...(pathname === "/hold" ? { id: this.job?.id } : {}) }); }
    catch (error) { return reply(409, { error: error instanceof Error ? error.message : "Control unavailable" }); }
  };
  close(): void { this.comparing?.abort.abort(); if (this.comparing) this.comparing.cancelled = true; this.clearRecording(); if (this.job) { this.job.cancelled = true; this.job.abort.abort(); if (!this.job.closing) this.stop(this.job, "cancel"); } this.sessions.clear(); this.replies.clear(); this.awaiting.clear(); }
}

let microphone: Microphone | undefined;
export function microphoneReply(user: string, id: string, text: string, elapsedMs: number, delivered = true): void {
  microphone?.completed(user,id,text,elapsedMs,delivered);
}
export function microphoneLink(owner: string): string | undefined { return microphone?.linkFor(owner); }
export function startMicrophone(deps: MicDependencies): void {
  if (!microphoneEnabled()) return;
  try {
    const address = new URL(config.micControlUrl!);
    if (!/^https?:$/.test(address.protocol) || address.username || address.password || address.pathname !== "/") throw new Error("invalid microphone control address");
    microphone = new Microphone({ ...deps, compare: deps.compare ?? (config.micCompareCommand ? compareMicrophone : undefined) });
    const controller = microphone;
    if (!!config.micTlsCert !== !!config.micTlsKey) throw new Error("Configure both microphone TLS files.");
    const handler: http.RequestListener = (req, res) => {
      void controller.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); log.warn("microphone control failed"); });
    };
    const server = config.micTlsCert && config.micTlsKey
      ? https.createServer({cert:readFileSync(config.micTlsCert),key:readFileSync(config.micTlsKey)},handler)
      : http.createServer(handler);
    server.requestTimeout = 10000; server.headersTimeout = 5000;
    server.on("error", () => { microphone?.close(); microphone = undefined; log.warn("microphone controls unavailable"); });
    server.listen(config.micPort, config.micHost);
    process.once("exit", () => microphone?.close());
  } catch { microphone?.close(); microphone = undefined; log.warn("microphone controls unavailable"); }
}
