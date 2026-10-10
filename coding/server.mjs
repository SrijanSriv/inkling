import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { Worker } from './worker.mjs';

const env = process.env;
const secret = env.INKLING_CODING_SECRET;
if (!secret || secret.length < 32) throw new Error('INKLING_CODING_SECRET must be at least 32 characters.');
const runtime = env.INKLING_CODING_RUNTIME || path.join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, 'inkling-coding');
// /run/user is volatile. Do not put private Codex sessions on persistent disk.
if (!runtime.startsWith(`/run/user/${process.getuid()}/`)) throw new Error('Coding runtime must be in /run/user/<uid>/.');
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
// Reap project units left by a crash before removing their volatile runtime files.
const oldUnits = execFileSync('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', 'inkling-coding-project-*.service'], { encoding: 'utf8' }).trim();
for (const line of oldUnits.split('\n').filter(Boolean)) {
  const unit = line.trim().split(/\s+/)[0];
  if (/^inkling-coding-project-[a-z][a-z0-9-]*\.service$/.test(unit)) execFileSync('systemctl', ['--user', 'stop', unit], { timeout: 10_000, stdio: 'ignore' });
}
for (const name of fs.readdirSync(runtime)) fs.rmSync(path.join(runtime, name), { recursive: true, force: true });
const worker = new Worker({
  data: path.resolve(env.INKLING_CODING_DATA_DIR || path.join(os.homedir(), '.local/share/inkling-coding')),
  key: env.INKLING_CODING_STATE_KEY, runtime,
  previewUrl: env.INKLING_CODING_PREVIEW_URL?.replace(/\/$/, ''),
  timeout: Number(env.INKLING_CODING_TIMEOUT_MS || 1_800_000),
  codex: { managed: true, webSearch: env.INKLING_CODING_WEB_SEARCH || 'live', bin: env.INKLING_CODING_BIN || 'codex', version: env.INKLING_CODING_CODEX_VERSION || '0.162.1', auth: env.INKLING_CODING_AUTH_FILE || path.join(os.homedir(), '.codex/auth.json'), path: env.PATH, toolRoots: (env.INKLING_CODING_TOOL_ROOTS || '').split(':').filter(Boolean) },
});
if (env.INKLING_CODING_IMPORTS_FILE) {
  const imports = JSON.parse(fs.readFileSync(env.INKLING_CODING_IMPORTS_FILE, 'utf8'));
  for (const [alias, source] of Object.entries(imports)) worker.register(alias, source);
}
const authorized = req => {
  const got = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${secret}`);
  return got.length === expected.length && timingSafeEqual(got, expected);
};
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!authorized(req)) { res.writeHead(401).end(); return; }
  try {
    if (req.method !== 'POST' || req.url !== '/jobs') { res.writeHead(404).end(); return; }
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 64_000) throw new Error('Request exceeds limit.'); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (input.action === 'artifact') {
      const artifact = worker.artifact(input.job, input.owner);
      if (fs.statSync(artifact.file).size > 16 * 1024 * 1024) throw new Error('Archive exceeds the 16 MB WhatsApp delivery limit.');
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${artifact.name}"` });
      fs.createReadStream(artifact.file).pipe(res); return;
    }
    const result = worker.request(input);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 1000) })); }
});
server.requestTimeout = 15_000; server.headersTimeout = 10_000;
server.listen(Number(env.INKLING_CODING_PORT || 8100), '127.0.0.1', () => { console.log('coding worker listening'); void worker.pump(); });

// Static previews only: no execution of project server commands or access to API routes.
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
let previews;
if (env.INKLING_CODING_PREVIEW_URL) {
  previews = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if (req.method !== 'GET') throw new Error();
      const match = new URL(req.url, 'http://preview').pathname.match(/^\/p\/([\w-]{32})\/(.*)$/);
      const job = match && worker.state.jobs.find(j => j.previewToken === match[1] && j.previewUntil > Date.now() && j.state === 'ready');
      if (!job) throw new Error();
      const relative = decodeURIComponent(match[2] || 'index.html');
      if (relative.split('/').some(p => !p || p.startsWith('.') || p === '..') || relative.includes('\\')) throw new Error();
      const root = worker.projectDir(job.project), file = path.join(root, relative);
      if (!file.startsWith(root + '/') || fs.realpathSync(file) !== file || !fs.statSync(file).isFile() || fs.statSync(file).size > 10 * 1024 * 1024) throw new Error();
      const type = mime[path.extname(file)]; if (!type) throw new Error();
      res.writeHead(200, { 'Content-Type': type }); fs.createReadStream(file).pipe(res);
    } catch { res.writeHead(404).end('Preview not found or expired.'); }
  });
  previews.listen(Number(env.INKLING_CODING_PREVIEW_PORT || 8101), env.INKLING_CODING_PREVIEW_HOST || '127.0.0.1');
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { worker.shutdown(); server.close(); previews?.close(); process.exit(0); });
