import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const excluded = /^(?:\.git|\.codex|\.agents|\.ssh|\.tmp|\.env(?:\..*)?|node_modules|data|auth|coverage|auth\.json|credentials(?:\..*)?|tokens(?:\..*)?|\.cache|\.venv|__pycache__|.*\.(?:pem|key|sealed))$/i;
export function manifest(root) {
  const files = []; let bytes = 0;
  function walk(dir, depth = 0) {
    if (depth > 20) throw new Error('Project nesting exceeds limit.');
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (excluded.test(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) throw new Error('Project contains a symlink; remove it before exporting/importing.');
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile()) {
        const stat = fs.lstatSync(full);
        if (stat.nlink !== 1) throw new Error('Hard-linked files are not supported.');
        bytes += stat.size;
        if (stat.size > 10 * 1024 * 1024 || bytes > 50 * 1024 * 1024 || files.length >= 3000) throw new Error('Project export exceeds the 50 MB / 3000 file limit.');
        const name = path.relative(root, full);
        if (/[\x00-\x1f]/.test(name)) throw new Error('Unsupported filename.');
        files.push({ name, hash: createHash('sha256').update(fs.readFileSync(full)).digest('hex'), mode: stat.mode & 0o111 ? 0o755 : 0o644 });
      }
    }
  }
  walk(root); return files.sort((a, b) => a.name.localeCompare(b.name));
}
export const digest = files => createHash('sha256').update(JSON.stringify(files)).digest('hex');
export function copyProject(source, target) {
  const files = manifest(source);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const dest = path.join(target, file.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(source, file.name), dest, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dest, file.mode);
  }
  return files;
}
export function archive(root, target) {
  const files = manifest(root);
  // The exporter accepts an explicit file list, never an agent-supplied archive command.
  execFileSync('tar', ['-czf', target, '--null', '-T', '-'], {
    cwd: root, input: Buffer.from(files.map(f => `./${f.name}\0`).join('')), timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  return files;
}

export function projectPatch(before, after) {
  try { return execFileSync('diff', ['-ruN', '--', before, after], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 }); }
  catch (e) { if (e.status === 1 && typeof e.stdout === 'string') return e.stdout.split(before + '/').join('before/').split(after + '/').join('after/'); throw new Error('Diff exceeds the text preview limit; request the source archive.'); }
}
