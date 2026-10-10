import { MusicError, musicFailure, type Entry, type MusicReply, type MusicRequest, type MusicState, type Track } from "./music-types.js";
import { youtubeVideo, type MusicSource } from "./music-source.js";
import type { AudioPlayer } from "./music-mpv.js";
export const emptyMusicState = (): MusicState => ({ current: null, queue: [], history: [], volume: 70, position: 0, desired: "stopped", radio: false, playlists: {} });
export class MusicEngine {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private epoch = 0;
  private abort?: AbortController;
  private preparing: Track | null = null;
  private error?: { code: string; message: string };
  private radioEpoch = 0;
  private fetchingRadio = false;
  private closed = false;
  private operationEpoch = 0;
  constructor(readonly state: MusicState, private source: MusicSource, private player: AudioPlayer, private save: (state: MusicState) => void) {
    player.onEnd = reason => {
      if (this.preparing || this.closed) return;
      const epoch = this.epoch, current = this.state.current;
      void this.serial(async () => {
        this.operationEpoch = epoch;
        if (this.closed || epoch !== this.epoch || current !== this.state.current || this.preparing || this.state.desired !== "playing") return;
        if (reason !== "eof") { this.error = { code: "stream_interrupted", message: "Audio stopped unexpectedly. Use resume to retry this track; queued requests were retained." }; this.persist(); return; }
        if (current) this.state.history.push(current);
        this.state.history = this.state.history.slice(-100);
        this.state.current = null; this.state.position = 0; this.state.desired = "stopped"; this.persist();
        if (!this.state.queue.length && this.state.radio && current) await this.refill(current);
        if (this.state.queue.length) await this.advance();
      }).catch(e => { this.error = musicFailure(e) as { code: string; message: string }; });
    };
    player.onLost = () => {
      if (!this.closed && !this.preparing && this.state.desired !== "stopped") this.error = { code: "audio_engine", message: "The audio engine disconnected. Resume retries the saved track without clearing the queue." };
    };
  }
  private persist() { this.save(structuredClone(this.state)); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.waiting >= 32) return Promise.reject(new MusicError("busy", "The music service is busy. Please try again shortly."));
    this.waiting++;
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result.finally(() => this.waiting--);
  }
  private async find(query: string, signal?: AbortSignal) {
    const candidates = await this.source.search(query, signal);
    const [track] = candidates;
    if (!track) throw new MusicError("not_found", "No matching YouTube video was found. Nothing was changed.");
    if (!youtubeVideo(query)) throw new MusicError("selection_required", "Choose a matching video from these search results, then call the action with its exact URL. Playback was not changed.", candidates);
    return track;
  }
  private async load(track: Track, position = 0, paused = false) {
    if (this.closed || this.operationEpoch !== this.epoch) throw new MusicError("cancelled", "Music request cancelled.");
    const controller = new AbortController(); this.abort = controller; this.preparing = track;
    try {
      // Resolve first, so unavailable search results never interrupt current audio.
      const stream = await this.source.resolve(track, controller.signal);
      if (controller.signal.aborted) throw new MusicError("cancelled", "Music request cancelled.");
      await this.player.volume(this.state.volume);
      try { await this.player.load(stream, controller.signal, position, paused); }
      catch (e) {
        if (!(e instanceof MusicError) || e.code !== "audio_engine" || controller.signal.aborted) throw e;
        await this.player.load(stream, controller.signal, position, paused);
      }
      if (controller.signal.aborted) throw new MusicError("cancelled", "Music request cancelled.");
      this.error = undefined;
    } finally { if (this.abort === controller) this.abort = undefined; this.preparing = null; }
  }
  private async advance() {
    const entry = this.state.queue[0];
    if (!entry) throw new MusicError("queue_empty", "The queue is empty. The current song was left unchanged.");
    await this.load(entry.track);
    if (this.state.current) this.state.history.push(this.state.current);
    this.state.history = this.state.history.slice(-100);
    this.state.current = entry.track;
    const index = this.state.queue.indexOf(entry); if (index >= 0) this.state.queue.splice(index, 1); this.state.position = 0; this.state.desired = "playing";
    this.persist(); this.backgroundRadio();
  }
  private backgroundRadio() {
    if (this.state.radio && this.state.current && this.state.queue.length < 4) void this.refill(this.state.current);
  }
  private async refill(track: Track) {
    if (!this.state.radio || this.fetchingRadio || this.closed) return;
    this.fetchingRadio = true; const epoch = this.radioEpoch;
    try {
      const tracks = await this.source.mix(track);
      if (epoch !== this.radioEpoch || !this.state.radio || this.closed) return;
      const ids = new Set([this.state.current?.id, ...this.state.queue.map(e => e.track.id), ...this.state.history.slice(-30).map(t => t.id)]);
      for (const t of tracks) if (!ids.has(t.id) && this.state.queue.length < 200) { this.state.queue.push({ track: t, kind: "radio" }); ids.add(t.id); }
      this.persist();
    } catch { /* Optional radio failing must not affect requested songs. */ }
    finally { this.fetchingRadio = false; }
  }
  async restore() {
    if (!this.state.current || this.state.desired === "stopped") return;
    await this.serial(async () => {
      this.operationEpoch = this.epoch;
      const paused = this.state.desired === "paused";
      try { await this.load(this.state.current!, this.state.position, paused); if (paused) await this.player.pause(true); }
      catch (e) { const r = musicFailure(e); this.error = { code: r.code!, message: r.message }; }
    });
  }
  async checkpoint() {
    const status = await this.player.status();
    if (status.active && !this.preparing) { this.state.position = status.position; this.state.volume = status.volume; this.persist(); }
  }
  async status() {
    const p = await this.player.status();
    const playback = p.deviceAvailable === false ? "speaker_disconnected" : p.active ? p.paused ? "paused" : p.buffering ? "buffering" : "playing" : this.preparing ? "loading" : this.error ? "error" : "stopped";
    return { playback, current: this.state.current, preparing: this.preparing, position: p.active ? p.position : 0, duration: p.active ? p.duration : 0,
      volume: p.active ? p.volume : this.state.volume, muted: p.muted, audioOutput: p.output, speaker: p.device ?? null, speakerAvailable: p.deviceAvailable ?? null, audibleInRoom: "not remotely verifiable", radio: this.state.radio,
      requested: this.state.queue.filter(e => e.kind === "requested").length, radioTracks: this.state.queue.filter(e => e.kind === "radio").length, ...(this.error ? { lastError: this.error } : {}) };
  }
  async handle(r: MusicRequest): Promise<MusicReply> {
    try {
      if (this.closed) throw new MusicError("shutdown", "The music service is restarting.");
      if (r.action === "status") return { ok: true, message: "Live audio-engine status.", data: await this.status() };
      if (r.action === "queue") return { ok: true, message: "Upcoming songs, in playback order. The current song is separate.", data: { current: this.state.current, radio: this.state.radio, songs: this.state.queue } };
      if (r.action === "search") return { ok: true, message: "Video candidates only. Inspect titles/artists before choosing a matching URL; no audio was changed.", data: await this.source.search(r.query!) };
      if (r.action === "playlist_list") return { ok: true, message: "Saved playlists.", data: Object.entries(this.state.playlists).map(([name, tracks]) => ({ name, songs: tracks.length })) };
      // Stop can cancel an in-flight load. Other destructive operations never serve as recovery.
      if (r.action === "stop") {
        this.epoch++; this.radioEpoch++; this.abort?.abort();
        this.state.desired = "stopped";
        const p = await this.player.status(); if (p.active) this.state.position = p.position;
        await this.player.stop(); this.error = undefined; this.persist();
        return { ok: true, message: "Stopped. The current song and queue are retained for resume." };
      }
      if (r.action === "queue_clear") { this.state.queue = []; this.state.radio = false; this.radioEpoch++; this.persist(); return { ok: true, message: "Upcoming queue cleared; radio disabled. The current song was left unchanged." }; }
      if (r.action === "radio_off") { this.state.radio = false; this.radioEpoch++; this.state.queue = this.state.queue.filter(e => e.kind === "requested"); this.persist(); return { ok: true, message: "Radio off. Requested songs retained." }; }
      const epoch = this.epoch;
      return await this.serial(async () => {
        this.operationEpoch = epoch;
        if (epoch !== this.epoch) throw new MusicError("cancelled", "This pending music request was cancelled by stop.");
        switch (r.action) {
          case "play": {
            const track = await this.find(r.query!);
            if (epoch !== this.epoch) throw new MusicError("cancelled", "Music request cancelled.");
            await this.load(track);
            if (this.state.current) this.state.history.push(this.state.current);
            this.state.history = this.state.history.slice(-100); this.state.current = track; this.state.position = 0; this.state.desired = "playing";
            this.state.queue = this.state.queue.filter(e => e.kind === "requested"); this.radioEpoch++;
            this.persist(); this.backgroundRadio();
            return { ok: true, message: "Track loaded and advancing audio output confirmed. Requested queue preserved.", data: await this.status() };
          }
          case "next": await this.advance(); return { ok: true, message: "Advanced to the next queued song; audio output confirmed.", data: await this.status() };
          case "previous": {
            const previous = this.state.history.at(-1);
            if (!previous) throw new MusicError("no_previous", "There is no previous song.");
            await this.load(previous); this.state.history.pop();
            if (this.state.current) this.state.queue.unshift({ track: this.state.current, kind: "requested" });
            this.state.current = previous; this.state.position = 0; this.state.desired = "playing"; this.persist();
            return { ok: true, message: "Previous song loaded; the song you left is next in the queue.", data: await this.status() };
          }
          case "queue_add": case "queue_next": {
            if (this.state.queue.length >= 200) throw new MusicError("queue_full", "The queue already has 200 songs.");
            const generation = this.radioEpoch;
            const track = await this.find(r.query!);
            if (epoch !== this.epoch || generation !== this.radioEpoch) throw new MusicError("cancelled", "Queue changed while searching. This song was not added.");
            const index = r.action === "queue_next" ? 0 : this.state.queue.findIndex(e => e.kind === "radio");
            this.state.queue.splice(index < 0 ? this.state.queue.length : index, 0, { track, kind: "requested" }); this.persist();
            return { ok: true, message: "Song queued. Queueing does not start or resume playback; use resume if stopped.", data: { song: track, position: this.state.queue.findIndex(e => e.track === track) + 1 } };
          }
          case "pause": {
            const p = await this.player.status();
            if (!p.active) throw new MusicError("not_playing", "No active audio to pause. Use resume to retry the saved track.");
            await this.player.pause(true); this.state.desired = "paused"; this.state.position = p.position; this.persist(); return { ok: true, message: "Paused." };
          }
          case "resume": {
            const p = await this.player.status();
            if (p.active) await this.player.pause(false);
            else if (this.state.current) await this.load(this.state.current, this.state.position);
            else { await this.advance(); return { ok: true, message: "Started the first queued song.", data: await this.status() }; }
            this.state.desired = "playing"; this.error = undefined; this.persist(); return { ok: true, message: "Resumed.", data: await this.status() };
          }
          case "volume": case "volume_delta": {
            const p = await this.player.status();
            const value = Math.max(0, Math.min(100, r.action === "volume" ? r.volume! : (p.active ? p.volume : this.state.volume) + r.volume!));
            await this.player.volume(value); this.state.volume = value; this.persist(); return { ok: true, message: `Player volume: ${value}%. Speaker/system volume is separate.` };
          }
          case "radio_on": this.state.radio = true; this.persist(); this.backgroundRadio(); return { ok: true, message: "Radio enabled. Requested songs keep priority; related tracks are added automatically." };
          case "playlist_save": {
            const name = r.query!; if (name.length > 80 || /^(?:__proto__|constructor|prototype)$/.test(name)) throw new MusicError("playlist_name", "Use a playlist name under 80 characters.");
            const tracks = [...(this.state.current ? [this.state.current] : []), ...this.state.queue.filter(e => e.kind === "requested").map(e => e.track)];
            if (!tracks.length) throw new MusicError("empty_playlist", "There are no requested songs to save.");
            if (Object.keys(this.state.playlists).length >= 30 && !Object.hasOwn(this.state.playlists, name)) throw new MusicError("playlist_limit", "Up to 30 playlists can be saved.");
            this.state.playlists[name] = tracks; this.persist(); return { ok: true, message: `Saved playlist with ${tracks.length} songs.`, data: { name } };
          }
          case "playlist_play": {
            const tracks = Object.hasOwn(this.state.playlists, r.query!) ? this.state.playlists[r.query!] : undefined;
            if (!tracks?.length) throw new MusicError("playlist_missing", "No saved playlist has that name.");
            await this.load(tracks[0]); if (this.state.current) this.state.history.push(this.state.current);
            this.state.history = this.state.history.slice(-100);
            this.state.current = tracks[0]; this.state.queue = tracks.slice(1).map(track => ({ track, kind: "requested" })); this.state.radio = false; this.radioEpoch++;
            this.state.position = 0; this.state.desired = "playing"; this.persist(); return { ok: true, message: "Saved playlist started. Upcoming queue replaced with this playlist.", data: await this.status() };
          }
          case "playlist_delete": {
            if (!Object.hasOwn(this.state.playlists, r.query!)) throw new MusicError("playlist_missing", "No saved playlist has that name.");
            delete this.state.playlists[r.query!]; this.persist(); return { ok: true, message: "Saved playlist deleted. Playback and queue unchanged." };
          }
          default: throw new MusicError("invalid_request", "Unknown music action.");
        }
      });
    } catch (e) {
      const result = musicFailure(e);
      if (!["cancelled", "not_found", "queue_empty", "no_previous", "playlist_missing", "invalid_request", "queue_full", "selection_required"].includes(result.code!)) this.error = { code: result.code!, message: result.message };
      return result;
    }
  }
  async close() {
    await this.checkpoint().catch(() => {});
    this.closed = true; this.epoch++; this.radioEpoch++; this.abort?.abort();
    await this.tail; this.persist(); await this.player.close();
  }
}
