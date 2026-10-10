import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { manifest, copyProject } from './files.mjs';
const exec = promisify(execFile);

export function publicRepository(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Repository must be a public GitHub HTTPS URL.');
  const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(value);
  if (!match || ['.', '..'].includes(match[2])) throw new Error('Use a public https://github.com/owner/repository URL, without credentials, query parameters or a branch path.');
  return `https://github.com/${match[1]}/${match[2]}`;
}

// Source preparation has narrow network access; project commands still have none.
export async function importRepository(value, cwd, signal) {
  const repository = publicRepository(value);
  if (!repository) throw new Error('Repository URL required.');
  if (manifest(cwd).length) throw new Error('Repository import requires an empty project; existing source was preserved.');
  const temp = fs.mkdtempSync(path.join(path.dirname(cwd), '.import-'));
  try {
    const download = path.join(temp, 'source.tar.gz');
    const response = await fetch(repository.replace('https://github.com/', 'https://codeload.github.com/') + '/tar.gz/HEAD', {
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
    });
    if (!response.ok || !response.body) throw new Error('Public GitHub source could not be fetched. Check the repository URL; private repositories are not supported.');
    let bytes = 0;
    const fd = fs.openSync(download, 'wx', 0o600);
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 20 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error('Repository download exceeds the 20 MB limit.'); }
        fs.writeSync(fd, chunk);
      }
    } finally { fs.closeSync(fd); }
    const source = path.join(temp, 'source'); fs.mkdirSync(source, { mode: 0o700 });
    // Never extract archive paths or links with tar's default extraction behavior.
    await exec('python3', ['-c', `import tarfile,pathlib,sys,os,posixpath,shutil
root=pathlib.Path(sys.argv[2]); total=0; count=0; prefix=None; links=[]
with tarfile.open(sys.argv[1], 'r:gz') as archive:
 for entry in archive:
  count+=1
  if count>6000: raise ValueError('Too many repository entries')
  parts=pathlib.PurePosixPath(entry.name).parts
  if not parts or entry.name.startswith('/') or any(p in ('.','..') or '\\\\' in p or any(ord(c)<32 for c in p) for p in parts): raise ValueError('Unsafe repository path')
  if prefix is None: prefix=parts[0]
  if parts[0]!=prefix: raise ValueError('Multiple repository roots')
  if not entry.isdir() and not entry.isfile() and not entry.issym(): raise ValueError('Repository hard links and special files are unsupported')
  if len(parts)==1:
   if not entry.isdir(): raise ValueError('Invalid archive root')
   continue
  if len(parts)>21: raise ValueError('Repository nesting exceeds limit')
  dest=root.joinpath(*parts[1:])
  if entry.isdir(): dest.mkdir(parents=True,exist_ok=True); continue
  if entry.issym():
   if entry.linkname.startswith('/') or any(ord(c)<32 or c==chr(92) for c in entry.linkname): raise ValueError('Unsafe repository link')
   target=posixpath.normpath(posixpath.join(posixpath.dirname(entry.name),entry.linkname))
   if not target.startswith(prefix+'/'): raise ValueError('Repository link escapes its root')
   links.append((dest,root.joinpath(*pathlib.PurePosixPath(target).parts[1:])))
   continue
  total+=entry.size
  if entry.size>10*1024*1024 or total>50*1024*1024: raise ValueError('Repository source exceeds size limit')
  dest.parent.mkdir(parents=True,exist_ok=True)
  with archive.extractfile(entry) as src, dest.open('xb') as out:
   while True:
    chunk=src.read(65536)
    if not chunk: break
    out.write(chunk)
  dest.chmod(0o755 if entry.mode & 0o111 else 0o644)
# Flatten internal file links; never create filesystem links or follow a link outside the archive.
for dest,target in links:
 if not target.is_file() or target in [d for d,t in links]: raise ValueError('Only links to regular repository files are supported')
 total+=target.stat().st_size
 if total>50*1024*1024: raise ValueError('Repository source exceeds size limit')
 dest.parent.mkdir(parents=True,exist_ok=True)
 with target.open('rb') as src, dest.open('xb') as out: shutil.copyfileobj(src,out)
 dest.chmod(target.stat().st_mode & 0o777)
`, download, source], { signal, timeout: 30_000, maxBuffer: 1000 }).catch(() => { throw new Error('Repository archive could not be safely imported; escaping or unsupported links, oversized files and unsafe paths are rejected.'); });
    signal.throwIfAborted();
    // Validate the sanitized copy before making any source visible to the coding process.
    const prepared = path.join(temp, 'prepared'); copyProject(source, prepared);
    if (!manifest(prepared).length) throw new Error('Repository contains no supported source files.');
    if (manifest(cwd).length) throw new Error('Project changed during import; existing source was preserved.');
    // The project is still empty; rename the fully prepared directory into place atomically.
    const previous = path.join(temp, 'empty'); fs.renameSync(cwd, previous);
    try { fs.renameSync(prepared, cwd); } catch (e) { fs.renameSync(previous, cwd); throw e; }
    return repository;
  } catch (e) {
    if (signal.aborted) throw new Error('Repository import cancelled.');
    if (/Repository|repository|Public GitHub|Project changed/.test(String(e.message))) throw e;
    throw new Error('Public GitHub source download failed or timed out. Retry when the laptop is connected.');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
