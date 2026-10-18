// Trusted adapter around the same pinned, isolated Codex used by the general coding worker.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateReport, probeOutput, reviewInput } from './software-report.mjs';
import { Codex } from '../coding/codex.mjs';
const [configFile, workspace, reportFile, resultFile, contextFile] = process.argv.slice(2);
const evidence = validateReport(JSON.parse(fs.readFileSync(reportFile, 'utf8')));
const instructions = fs.readFileSync(new URL('./review-instructions.md', import.meta.url), 'utf8');
const c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const runtime = path.join(c.state, 'codex-runtime');
let last, resolveTurn, rejectTurn;
const completed = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
const rpc = new Codex({ bin: c.codex_bin, version: c.codex_version, auth: c.codex_auth,
  runtime, toolRoots: c.tool_roots, path: c.tool_path, webSearch: 'live', unit: 'inkling-nightly-codex' }, msg => {
  if (msg.id !== undefined && msg.method) {
    if (msg.method === 'item/permissions/requestApproval') rpc.answer(msg.id, { permissions: {}, scope: 'turn' });
    else if (msg.method.includes('requestApproval')) rpc.answer(msg.id, { decision: 'decline' });
    else rpc.send({ id: msg.id, error: { code: -32601, message: 'Unattended review cannot request input or use extra tools.' } });
  }
  if (msg.method === 'item/completed' && msg.params?.item?.type === 'agentMessage') last = msg.params.item.text;
  if (msg.method === 'turn/completed') {
    if (msg.params.turn.status === 'completed') resolveTurn();
    else rejectTurn(new Error('Review turn did not complete'));
  }
  if (msg.method === 'worker/disconnected') rejectTurn(new Error('Codex disconnected'));
});
// Avoid an unhandled rejection if startup fails before we await completion.
completed.catch(() => {});
const timer = setTimeout(() => rejectTurn(new Error('Review exceeded 30 minutes')), 1_800_000);
try {
  await rpc.start(workspace);
  const env = { HOME: path.join(workspace,'.tmp'), TMPDIR: path.join(workspace,'.tmp'), PATH: c.tool_path };
  const probe = await rpc.call('command/exec', { cwd: workspace, env, timeoutMs: 10000, outputBytesCap: 1000,
    command: ['/usr/bin/python3', '-c', `import pathlib,socket,sys
for name in sys.argv[1:]:
 try: assert not pathlib.Path(name).exists(), 'private path visible'
 except PermissionError: pass
pathlib.Path('.tmp/preflight').write_text('ok')
try:
 s=socket.socket(); s.settimeout(1)
 assert s.connect_ex(('127.0.0.1',8100)) != 0, 'network visible'
except PermissionError: pass
print('isolated')`, c.backup_password, c.github_token, c.checkout, path.join(c.state,'inbox'), path.join(c.state,'feedback-inbox'), configFile, c.codex_auth, path.join(runtime,'auth.json'), path.join(c.state,'backups','config')] });
  if (probe.exitCode !== 0 || !String(probe.stdout).includes('isolated')) throw new Error('Review sandbox preflight failed');
  const strings = {type:'array',items:{type:'string'}};
  const reference = {type:'object',properties:{path:{type:'string'},line:{type:'integer'}},required:['path','line'],additionalProperties:false};
  const outcome = states => ({type:'object',properties:{id:{type:'string'},state:{type:'string',enum:states},note:{type:'string'}},required:['id','state','note'],additionalProperties:false});
  const ledger = {type:'object',properties:{sources:strings,problem:{type:'string'},before:{type:'string'},change:{type:'string'},verification:{type:'string'},limitations:{type:'string'},beforeRefs:{type:'array',items:reference},afterRefs:{type:'array',items:reference}},
    required:['sources','problem','before','change','verification','limitations','beforeRefs','afterRefs'],additionalProperties:false};
  const schema = {type:'object',properties:{title:{type:'string'},summary:{type:'string'},body:{type:'string'},advice:strings,deferred:strings,
    targetOutcomes:{type:'array',items:outcome(['proposed','no_issue','deferred'])},
    requestOutcomes:{type:'array',items:outcome(['proposed','needs_info','deferred'])},issueLedger:{type:'array',items:ledger}},
    required:['title','summary','body','advice','deferred','requestOutcomes','targetOutcomes','issueLedger'],additionalProperties:false};
  const thread = await rpc.call('thread/start', { cwd:workspace, ephemeral:true, approvalPolicy:'never',
    config:{shell_environment_policy:{inherit:'none',set:env}},
    developerInstructions:instructions });
  const context = JSON.parse(fs.readFileSync(contextFile,'utf8'));
  // Trusted suite is copied into disposable scratch, never read from model-edited source.
  const suiteRoot = path.join(workspace,'.tmp','audit-suite');
  fs.mkdirSync(suiteRoot,{recursive:true});
  const suiteText = fs.readFileSync(new URL('./probes/software-probes.mjs',import.meta.url),'utf8');
  if(fs.readFileSync(path.join(workspace,'ops/probes/software-probes.mjs'),'utf8')!==suiteText)throw new Error('Trusted suite differs from public source; operator update required');
  fs.writeFileSync(path.join(suiteRoot,'software-probes.mjs'),suiteText);
  async function softwareChecks() {
    // Create, write and remove scratch only INSIDE the sandbox. Model-created symlinks must
    // never redirect privileged host writes; the executed suite is the trusted in-memory copy.
    const bootstrap = `const _auditFs=await import('node:fs');
const _auditScratch=_auditFs.mkdtempSync(process.cwd()+'/.tmp/audit-probe-');
_auditFs.writeFileSync(_auditScratch+'/users.json',JSON.stringify({users:[{id:'audit',name:'Example',phone:'447700900001',timezone:'UTC',admin:true,owner:true}]}));
process.env.INKLING_DATA_DIR=_auditScratch;process.env.AUDIT_SCRATCH=_auditScratch;
process.chdir(_auditScratch);\n`;
    const checked = await rpc.call('command/exec',{cwd:workspace,env:{...env,AUDIT_SOURCE_ROOT:workspace,INKLING_SECRET_KEY:crypto.randomBytes(32).toString('base64')},timeoutMs:90000,outputBytesCap:16000,
      command:[c.node,'--import',path.join(workspace,'node_modules/tsx/dist/loader.mjs'),'--input-type=module','-e',bootstrap+suiteText+`\n_auditFs.rmSync(_auditScratch,{recursive:true,force:true});`]},100000);
    if(checked.exitCode!==0) throw new Error('Isolated software suite failed; raw output withheld');
    return probeOutput(checked.stdout);
  }
  const baseline = await softwareChecks();
  fs.writeFileSync(path.join(c.state,'last-software-review-input.json'),JSON.stringify({pi:evidence,current:baseline}),{mode:0o600});
  const prompt = reviewInput(evidence,baseline,context);
  fs.writeFileSync(path.join(c.state,'last-software-review-prompt.txt'),instructions+'\n\n'+prompt,{mode:0o600});
  // Preflight mode exercises the real filesystem/network sandbox without starting a model turn.
  if(process.argv.includes('--preflight-only')) {
    fs.writeFileSync(resultFile,JSON.stringify({pi:evidence,current:baseline,modelStarted:false}),{mode:0o600});
    process.exitCode=0;
  } else {
    await rpc.call('turn/start',{threadId:thread.thread.id,cwd:workspace,approvalPolicy:'never',outputSchema:schema,
      input:[{type:'text',text:prompt}]});
    await completed;
    await rpc.call('thread/backgroundTerminals/clean',{threadId:thread.thread.id});
    const report = JSON.parse(last);
    const check = await rpc.call('command/exec',{cwd:workspace,env,timeoutMs:120000,outputBytesCap:3000,command:['npm','run','typecheck']},130000);
    report.typecheckPassed = check.exitCode === 0;
    if (!report.typecheckPassed) throw new Error('Review typecheck failed');
    // Syntax check browser and coding modules without loading or starting them.
    for (const dir of ['browser','coding']) {
      for (const file of fs.readdirSync(path.join(workspace,dir)).filter(f=>f.endsWith('.mjs'))) {
        const checked = await rpc.call('command/exec',{cwd:workspace,env,timeoutMs:10000,outputBytesCap:1000,command:['node','--check',`${dir}/${file}`]});
        if (checked.exitCode !== 0) throw new Error('Review syntax check failed');
      }
    }
    const after = await softwareChecks();
    // Refuse a PR that breaks a previously passing fixed probe.
    if(baseline.results.some((r,i)=>r.result==='pass'&&after.results[i].result!=='pass')) throw new Error('Synthetic probe regression');
    report.softwareChecks = after;
    fs.writeFileSync(resultFile,JSON.stringify(report),{mode:0o600});
  }
} finally { clearTimeout(timer); rpc.stop(); }
