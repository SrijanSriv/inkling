import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { manifest, digest, copyProject, archive, projectPatch } from './files.mjs';
import { Codex } from './codex.mjs';

const running = new Set(['preparing', 'running', 'checking', 'waiting_for_input']);
const slug = /^[a-z][a-z0-9-]{0,47}$/;
const text = (v, max = 12_000) => { if (typeof v !== 'string' || !v.trim() || v.length > max || v.includes('\0')) throw new Error('Invalid request text.'); return v.trim(); };
export class Worker {
  constructor(options, factory = (opts, events) => new Codex(opts, events)) {
    this.options = options; this.factory = factory; this.key = Buffer.from(options.key, 'base64');
    if (this.key.length !== 32) throw new Error('Coding state key must be 32 bytes.');
    fs.mkdirSync(options.data, { recursive: true, mode: 0o700 });
    this.file = path.join(options.data, 'jobs.sealed');
    this.state = fs.existsSync(this.file) ? this.decode(fs.readFileSync(this.file)) : { next: 0, jobs: [], projects: {}, events: [], receipts: {} };
    for (const job of this.state.jobs) delete job.threadId;
    for (const job of this.state.jobs) if (running.has(job.state)) { if (job.question) job.lastReport = (job.report || '') + '\nPending question: ' + job.question.questions.map(q => q.question).join('\n'); job.state = 'interrupted'; job.question = null; this.event(job, 'Work was interrupted by a restart. The files are saved; ask to continue.'); }
    this.save(); this.active = null; this.sessions = new Map();
  }
  encode(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv); const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); }
  decode(buf) { const d = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28)); return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString()); }
  save() { fs.writeFileSync(this.file + '.tmp', this.encode(this.state), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); }
  event(job, message) { this.state.events.push({ seq: ++this.state.next, job: job.id, owner: job.owner, revision: job.revision, message: `${job.id} · ${job.project}: ${message}` }); }
  projectDir(alias) { return path.join(this.options.data, 'projects', alias); }
  job(id, owner) { const job = this.state.jobs.find(j => j.id === String(id).toUpperCase() && j.owner === owner); if (!job) throw new Error('Coding job not found. Specify its job ID.'); return job; }
  view(job) { return { id: job.id, project: job.project, revision: job.revision, state: job.state, report: job.report || '', question: job.question?.questions || null, files: (job.changed || []).slice(0, 100), changedFiles: (job.changed || []).length, checks: (job.checks || []).map(c => ({ ...c, output: c.output.slice(0, 600) })), preview: job.preview || null }; }
  request(input) {
    const owner = text(input.owner, 80), action = input.action;
    if (action === 'projects') return Object.entries(this.state.projects).map(([name, p]) => ({ name, lastJob: p.lastJob }));
    if (action === 'status') return input.job ? this.view(this.job(input.job, owner)) : this.state.jobs.filter(j => j.owner === owner).slice(-20).map(j => this.view(j));
    if (action === 'diff') { const job = this.job(input.job, owner); return { job: job.id, revision: job.revision, diff: job.patch || 'No completed diff yet.' }; }
    if (action === 'events') {
      const after = Number(input.after || 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid event cursor.');
      return this.state.events.filter(e => e.owner === owner && e.seq > after).slice(0, 20);
    }
    if (!['start', 'continue', 'cancel'].includes(action)) throw new Error('Unsupported coding operation.');
    const receipt = text(input.requestId, 200), receiptKey = `${owner}:${receipt}`;
    if (this.state.receipts[receiptKey]) return this.view(this.job(this.state.receipts[receiptKey], owner));
    let job;
    if (action === 'start') {
      const alias = text(input.project, 48), brief = text(input.prompt);
      if (!slug.test(alias)) throw new Error('Project names must start with a letter and contain lowercase letters, digits or hyphens.');
      if (this.state.projects[alias]?.lastJob) throw new Error('That project exists. Continue its latest job rather than creating it again.');
      this.ensureQueue();
      const id = `C${this.state.jobs.length + 1}`;
      job = { id, owner, project: alias, revision: 1, state: 'queued', requests: [brief], baseline: [], createdAt: Date.now() };
      this.state.jobs.push(job); this.state.projects[alias] = { lastJob: id };
      fs.mkdirSync(this.projectDir(alias), { recursive: true, mode: 0o700 });
    } else {
      job = input.job ? this.job(input.job, owner) : this.job(this.state.projects[input.project]?.lastJob, owner);
      if (action === 'cancel') {
        if (!running.has(job.state) && job.state !== 'queued') throw new Error('That job is not active or queued. Its files are retained.');
        job.state = 'cancelled'; job.question = null; job.preview = null;
        if (this.active?.job === job) this.finish(this.active);
        this.event(job, 'Cancelled. Project files are retained.');
      } else {
        const prompt = text(input.prompt);
        if (job.state === 'waiting_for_input' && this.active?.job === job) {
          const q = job.question;
          if (q.questions.some(q => q.isSecret)) throw new Error('Do not send secrets to coding jobs.');
          this.active.rpc.answer(q.rpcId, { answers: Object.fromEntries(q.questions.map(q => [q.id, { answers: [prompt] }])) });
          job.requests.push(prompt); job.question = null; job.state = 'running'; this.active.deadline = Date.now() + this.active.remaining;
        } else {
          if ((running.has(job.state) && !(job.state === 'waiting_for_input' && job.question?.rpcId === null)) || job.state === 'queued') throw new Error('That project is already busy. Wait or cancel before continuing.');
          this.ensureQueue(); job.requests.push(prompt); job.revision++; job.state = 'queued'; job.preview = null; job.report = ''; job.patch = null; job.checks = [];
        }
      }
    }
    this.state.receipts[receiptKey] = job.id;
    this.save(); setImmediate(() => this.pump()); return this.view(job);
  }
  ensureQueue() { if (this.state.jobs.filter(j => j.state === 'queued').length >= 5) throw new Error('The coding queue is full.'); }
  async pump() {
    if (this.active) return;
    const job = this.state.jobs.find(j => j.state === 'queued'); if (!job) return;
    const cwd = this.projectDir(job.project);
    const existing = this.sessions.get(job.project);
    if (existing) { this.sessions.delete(job.project); this.sessions.set(job.project, existing); }
    const rpc = existing || this.factory({ ...this.options.codex, unit: this.options.codex.managed ? `inkling-coding-project-${job.project}.service` : undefined, runtime: path.join(this.options.runtime, job.project) }, msg => { if (this.active?.job.project === job.project) this.receive(this.active.job, msg); });
    const active = this.active = { job, rpc, deadline: Date.now() + (this.options.timeout || 1_800_000), remaining: 1_800_000 };
    try {
      const tmp = path.join(cwd, '.tmp');
      if (fs.existsSync(tmp) && fs.lstatSync(tmp).isSymbolicLink()) throw new Error('Project scratch directory must not be a symlink.');
      fs.mkdirSync(tmp, { recursive: true });
      job.baseline = manifest(cwd);
    } catch (e) { this.fail(job, e.message); return; }
    job.state = 'preparing'; job.followupQuestion = null; job.question = null; job.changed = []; job.report = ''; job.checks = []; this.save();
    active.timer = setInterval(() => {
      if (job.state !== 'waiting_for_input' && Date.now() > active.deadline) this.fail(job, 'Coding time limit reached. Files are saved; ask to continue.');
      if (job.state === 'waiting_for_input' && Date.now() - job.question.at > 24 * 60 * 60_000) this.fail(job, 'The question expired. Ask to continue when ready.');
    }, 1000);
    try {
      active.before = path.join(this.options.data, 'baselines', `${job.id}-r${job.revision}`);
      if (!fs.existsSync(active.before)) copyProject(cwd, active.before);
      if (!existing) {
        while (this.sessions.size >= 3) {
          const [alias, old] = this.sessions.entries().next().value; old.stop(); this.sessions.delete(alias);
          for (const j of this.state.jobs) if (j.project === alias) delete j.threadId;
        }
        await rpc.start(cwd); this.sessions.set(job.project, rpc);
      }
      // Prove the installed permission profile applies before a model sees a task.
      const canary = path.join(this.options.data, 'sandbox-canary'); fs.writeFileSync(canary, 'private canary', { mode: 0o600 });
      const probe = await rpc.call('command/exec', {
        cwd, env: { HOME: path.join(cwd, '.tmp'), TMPDIR: path.join(cwd, '.tmp') }, timeoutMs: 10_000, outputBytesCap: 1000,
        command: ['/usr/bin/python3', '-c', `import pathlib,socket,sys
assert not pathlib.Path(sys.argv[1]).exists(), "outside read allowed"
assert not pathlib.Path(sys.argv[2]).exists(), "auth read allowed"
pathlib.Path(".tmp/probe").write_text("ok")
try:
 s=socket.socket(); s.settimeout(1)
 assert s.connect_ex(("127.0.0.1",8100)) != 0, "network allowed"
except PermissionError: pass
print("isolated")`, canary, path.join(this.options.runtime, job.project, 'auth.json')],
      });
      if (probe.exitCode !== 0 || !String(probe.stdout).includes('isolated')) throw new Error('Coding sandbox preflight failed. No coding turn was started.');
      if (job.state === 'cancelled') return this.finish(active);
      let threadId = job.threadId;
      if (!threadId) {
      const thread = await rpc.call('thread/start', { cwd, config: { shell_environment_policy: { inherit: 'none', set: { PATH: this.options.codex.path, HOME: path.join(cwd, '.tmp'), TMPDIR: path.join(cwd, '.tmp'), LANG: 'C.UTF-8' } } }, ephemeral: true, approvalPolicy: 'never', developerInstructions: 'You are coding a general project requested through WhatsApp. Work only in the provided workspace. Make reversible implementation choices without asking. Do not deploy, publish, contact others, change host services, access credentials or use personal accounts. No subagents. Command network is unavailable; prefer installed tools and dependency-free solutions, and report missing dependencies honestly. Run appropriate checks. Your final reply must be concise natural language, describe actual changes and limitations, and never claim a check passed without running it. No em dashes. If an essential answer is needed, use request_user_input. Do not leave background processes running. Do not save private conversation transcripts in source files.' });
      threadId = job.threadId = thread.thread.id;
      }
      active.thread = threadId;
      job.state = 'running'; this.event(job, 'Started on the laptop.'); this.save();
      const context = job.requests.map((p, i) => `${i + 1}. ${p}`).join('\n\n');
      const turn = await rpc.call('turn/start', { threadId: active.thread, cwd, approvalPolicy: 'never', outputSchema: { type: 'object', properties: { summary: { type: 'string' }, question: { type: ['string', 'null'] } }, required: ['summary', 'question'], additionalProperties: false }, input: [{ type: 'text', text: `Project ${job.project}, revision ${job.revision}. Continue from the files already present. Requests in order:\n${context}\n\nPrevious result: ${job.lastReport || 'None'}` }] });
      active.turn = turn.turn.id;
    } catch (e) { if (job.state === 'cancelled') this.finish(active); else this.fail(job, e.message); }
  }
  receive(job, msg) {
    const active = this.active; if (!active || active.job !== job || job.state === 'cancelled') return;
    if (msg.id !== undefined && msg.method) {
      if (msg.method === 'item/tool/requestUserInput' && Array.isArray(msg.params?.questions) && !msg.params.questions.some(q => q.isSecret)) {
        job.question = { rpcId: msg.id, questions: msg.params.questions, at: Date.now() };
        active.remaining = Math.max(1, active.deadline - Date.now()); job.state = 'waiting_for_input';
        this.event(job, `Needs your answer. Reply with ${job.id}:\n${job.question.questions.map(q => q.question + (q.options?.length ? '\n' + q.options.map(o => o.label).join(' / ') : '')).join('\n')}`); this.save();
      } else {
        // Permission escalation is not a WhatsApp yes/no action in v1.
        const result = msg.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : msg.method.includes('requestApproval') ? { decision: 'decline' } : null;
        if (result) active.rpc.answer(msg.id, result);
        else { try { active.rpc.send({ id: msg.id, error: { code: -32601, message: 'Unsupported worker request' } }); } catch {} }
      }
    }
    const p = msg.params;
    if (p?.threadId && active.thread && p.threadId !== active.thread) return;
    if (msg.method === 'item/completed' && p?.item?.type === 'agentMessage') {
      const raw = String(p.item.text || '');
      try { const report = JSON.parse(raw); job.report = String(report.summary || '').slice(0, 5000); job.followupQuestion = typeof report.question === 'string' ? report.question.slice(0, 1500) : null; }
      catch { job.report = raw.slice(0, 5000); job.followupQuestion = null; }
      this.save();
    }
    if (msg.method === 'turn/completed' && !active.finishing) {
      active.finishing = true;
      if (p.turn.status !== 'completed') this.fail(job, p.turn.error?.message || `Codex turn ${p.turn.status}.`);
      else if (job.followupQuestion) {
        job.lastReport = (job.report || '') + '\nQuestion: ' + job.followupQuestion;
        job.state = 'waiting_for_input'; job.question = { rpcId: null, questions: [{ id: 'clarification', question: job.followupQuestion }], at: Date.now() };
        this.event(job, `Needs your answer. Reply with ${job.id}: ${job.followupQuestion}`); this.save(); this.finish(active);
      } else void this.check(active);
    }
    if (msg.method === 'worker/disconnected' && !active.finishing) this.fail(job, 'Codex disconnected. Files are saved; ask to continue.');
  }
  async check(active) {
    const { job, rpc } = active, cwd = this.projectDir(job.project);
    try {
      await rpc.call('thread/backgroundTerminals/clean', { threadId: active.thread });
      job.state = 'checking'; job.question = null; this.save();
      const files = manifest(cwd), old = new Map(job.baseline.map(f => [f.name, f.hash])), now = new Map(files.map(f => [f.name, f.hash]));
      job.changed = [...new Set([...old.keys(), ...now.keys()])].filter(n => old.get(n) !== now.get(n)); job.digest = digest(files);
      const commands = [];
      for (const file of files) if (/\.(mjs|cjs|js)$/.test(file.name) && !file.name.startsWith('.tmp/')) commands.push(['node', '--check', file.name]);
      if (files.some(f => f.name === 'package.json')) {
        const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
        for (const script of ['typecheck', 'test']) if (pkg.scripts?.[script]) commands.push(['npm', 'run', script]);
      }
      for (const command of commands.slice(0, 25)) {
        if (job.state === 'cancelled') return;
        try {
          const result = await rpc.call('command/exec', { command, cwd, env: { HOME: path.join(cwd, '.tmp'), TMPDIR: path.join(cwd, '.tmp') }, timeoutMs: 60_000, outputBytesCap: 8000 }, 65_000);
          job.checks.push({ command: command.join(' '), exitCode: result.exitCode, output: `${result.stdout || ''}${result.stderr || ''}`.slice(0, 8000) });
        } catch (e) { job.checks.push({ command: command.join(' '), exitCode: null, output: e.message }); }
      }
      if (job.state === 'cancelled') return;
      await rpc.call('thread/backgroundTerminals/clean', { threadId: active.thread });
      const finalFiles = manifest(cwd);
      if (digest(finalFiles) !== job.digest) job.checks.push({ command: 'workspace unchanged during verification', exitCode: 1, output: 'Checks modified project files; review and rerun.' });
      const artifacts = path.join(this.options.data, 'artifacts'); fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
      const archivePath = path.join(artifacts, `${job.id}-r${job.revision}.tar.gz`);
      archive(cwd, archivePath); job.artifact = archivePath; job.artifactRevision = job.revision;
      const after = path.join(this.options.data, 'baselines', `${job.id}-r${job.revision}-after`);
      copyProject(cwd, after);
      try { job.patch = projectPatch(active.before, after); } catch (e) { job.patch = e.message; }
      fs.rmSync(after, { recursive: true, force: true });
      job.state = 'ready'; job.lastReport = job.report;
      const failed = job.checks.filter(c => c.exitCode !== 0).length;
      const verification = !commands.length ? 'No automated checks were available.' : `${job.checks.length - failed} checks passed${failed ? `; ${failed} failed or could not run` : ''}.`;
      if (this.options.previewUrl && finalFiles.some(f => f.name === 'index.html')) { job.previewToken = randomBytes(24).toString('base64url'); job.previewUntil = Date.now() + 60 * 60_000; job.preview = `${this.options.previewUrl}/p/${job.previewToken}/`; }
      this.event(job, `Ready for review. ${job.changed.length} files changed. ${verification}\n${job.report || 'Source is saved.'}${job.preview ? `\nHome Wi-Fi preview: ${job.preview}` : ''}\nAsk for the source with ${job.id}.`); this.save();
    } catch (e) { if (job.state !== 'cancelled') this.fail(job, `Could not verify/export: ${e.message}`); }
    finally { this.finish(active); }
  }
  fail(job, message) {
    if (['failed', 'cancelled', 'ready'].includes(job.state)) return;
    job.state = 'failed'; job.question = null; job.report = String(message).slice(0, 1000); this.event(job, `Stopped: ${job.report}`); this.save();
    if (this.active?.job === job) this.finish(this.active);
  }
  finish(active) {
    if (this.active !== active) return;
    clearInterval(active.timer); this.active = null;
    if (active.job.state !== 'ready' && !(active.job.state === 'waiting_for_input' && active.job.question?.rpcId === null)) { active.rpc.stop(); this.sessions.delete(active.job.project); for (const job of this.state.jobs) if (job.project === active.job.project) delete job.threadId; }
    this.save(); setImmediate(() => this.pump());
  }
  artifact(id, owner) { const job = this.job(id, owner); if (!job.artifact || job.artifactRevision !== job.revision || !fs.existsSync(job.artifact)) throw new Error('No completed source artifact yet.'); return { file: job.artifact, name: `${job.project}-${job.id}.tar.gz` }; }
  register(alias, source) {
    if (!slug.test(alias)) throw new Error('Invalid registered project alias.');
    if (this.state.projects[alias]) return;
    const target = this.projectDir(alias);
    if (fs.existsSync(target)) throw new Error('Import destination already exists.');
    try { copyProject(fs.realpathSync(source), target); } catch (e) { fs.rmSync(target, { recursive: true, force: true }); throw e; }
    this.state.projects[alias] = { lastJob: null }; this.save();
  }
  shutdown() { if (this.active) { const active = this.active; active.job.state = 'interrupted'; active.job.question = null; clearInterval(active.timer); this.active = null; } for (const rpc of this.sessions.values()) rpc.stop(); this.sessions.clear(); this.save(); }
}
