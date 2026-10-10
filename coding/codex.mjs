import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

export class Codex {
  constructor(options, onEvent) { this.options = options; this.onEvent = onEvent; this.pending = new Map(); this.next = 0; }
  async start(cwd) {
    const { runtime, auth, bin, version, toolRoots = [] } = this.options;
    const installed = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
    if (installed !== `codex-cli ${version}`) throw new Error('Codex version changed; worker compatibility preflight required.');
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    this.initialAuth = fs.readFileSync(auth);
    fs.copyFileSync(auth, path.join(runtime, 'auth.json'));
    fs.chmodSync(path.join(runtime, 'auth.json'), 0o600);
    const roots = toolRoots.map(p => `${JSON.stringify(p)} = "read"`).join('\n');
    const filesystem = ['":minimal"="read"', ...toolRoots.map(p => `${JSON.stringify(p)}="read"`), '":workspace_roots"={"."="write"}'].join(',');
    // CLI overrides win over project configuration, including on an evicted session's restart.
    const flags = ['-c', 'default_permissions="coding"', '-c', `permissions={coding={filesystem={${filesystem}},network={enabled=false}}}`, '-c', 'approval_policy="never"', '-c', 'mcp_servers={}', '-c', 'hooks={}', '-c', 'web_search="disabled"'];
    fs.writeFileSync(path.join(runtime, 'config.toml'), `approval_policy = "never"\ndefault_permissions = "coding"\nweb_search = "disabled"\n[history]\npersistence = "none"\n[analytics]\nenabled = false\n[permissions.coding.filesystem]\n":minimal" = "read"\n${roots}\n[permissions.coding.filesystem.":workspace_roots"]\n"." = "write"\n[permissions.coding.network]\nenabled = false\n`, { mode: 0o600 });
    const env = { PATH: this.options.path, HOME: runtime, CODEX_HOME: runtime, XDG_CONFIG_HOME: runtime, XDG_CACHE_HOME: runtime, TMPDIR: path.join(cwd, '.tmp'), LANG: 'C.UTF-8', RUST_LOG: 'off' };
    fs.mkdirSync(env.TMPDIR, { recursive: true });
    this.busEnv = { PATH: this.options.path, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus` };
    const unit = this.options.unit;
    const command = unit ? 'systemd-run' : bin;
    const args = unit ? ['--user', '--quiet', '--pipe', '--wait', '--collect', '--service-type=exec', `--unit=${unit}`, '--slice=inkling-coding.slice', '-p', 'MemoryMax=1500M', '-p', 'TasksMax=128', '-p', 'TimeoutStopSec=5', '-p', `WorkingDirectory=${cwd}`, '/usr/bin/env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), bin, ...flags, 'app-server'] : [...flags, 'app-server'];
    this.child = spawn(command, args, { cwd, env: unit ? this.busEnv : env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => {}); // Raw model/server output must not reach journald.
    this.child.on('error', () => this.fail(new Error('Codex could not start.')));
    this.child.on('exit', () => { this.fail(new Error('Codex connection closed.')); this.onEvent({ method: 'worker/disconnected' }); });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      if (line.length > 4 * 1024 * 1024) { this.stop(); return; }
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && !msg.method) {
          const request = this.pending.get(msg.id);
          if (!request) return;
          this.pending.delete(msg.id); clearTimeout(request.timer);
          msg.error ? request.reject(new Error(String(msg.error.message).slice(0, 500))) : request.resolve(msg.result);
        } else this.onEvent(msg);
      } catch { this.fail(new Error('Invalid Codex protocol response.')); }
    });
    await this.call('initialize', { clientInfo: { name: 'inkling_coding', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
  }
  send(msg) { if (!this.child?.stdin.writable) throw new Error('Codex is disconnected.'); this.child.stdin.write(JSON.stringify(msg) + '\n'); }
  call(method, params, timeout = 30_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex request timed out.')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  answer(id, result) { this.send({ id, result }); }
  fail(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  stop() {
    if (this.options.unit && this.busEnv) {
      try { execFileSync('systemctl', ['--user', 'stop', this.options.unit], { env: this.busEnv, timeout: 8_000, stdio: 'ignore' }); } catch {}
    }
    if (this.child?.pid) { try { process.kill(-this.child.pid, 'SIGKILL'); } catch {} }
    this.fail(new Error('Codex stopped.'));
    // Authentication may refresh; preserve only the credential, never runtime logs/history.
    const fresh = path.join(this.options.runtime, 'auth.json');
    try {
      const content = fs.readFileSync(fresh);
      if (!content.equals(this.initialAuth) && fs.statSync(fresh).mtimeMs >= fs.statSync(this.options.auth).mtimeMs) {
        fs.writeFileSync(this.options.auth + '.inkling-tmp', content, { mode: 0o600 });
        fs.renameSync(this.options.auth + '.inkling-tmp', this.options.auth);
      }
    } catch {}
    fs.rmSync(this.options.runtime, { recursive: true, force: true });
  }
}
