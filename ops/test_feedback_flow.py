"""Synthetic end-to-end intake/consent/storage checks. Callback fakes; no network or real sends."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = r'''
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleFeedback, feedbackTopic, sensitiveDescription } from './feedback.js';
import { readLedger, writeLedger, recordIssue } from './reliability-store.js';
import { approvedFeedback, applyFeedbackReceipts } from './feedback-export.js';
import { config, getUsers, saveUsers } from './config.js';
import { announceNext } from './command-announcements.js';
const sent:{text:string;id?:string}[]=[];
const send=async(text:string,id?:string)=>{sent.push({text,id});};
let serial=0,checks=0;
const input=(actor='a',text='/feature Add optional GIF replies',group=false)=>({actor,chat:group?'group-example':actor,text,id:'fixture'+(++serial),at:Date.now(),group,plain:true,forwarded:false});
const check=(ok:unknown)=>{assert(ok);checks++;};
await handleFeedback(input(),send);let r=readLedger('a').requests.at(-1)!;
check(r.state==='preview');check(approvedFeedback().requests.length===0);
check(sent.at(-1)?.text.includes('PUBLIC GitHub PR'));
check(await handleFeedback({...input('b',`/feature approve ${r.id}`)},send));check(approvedFeedback().requests.length===0);
await handleFeedback({...input('a',`/feature approve ${r.id}`,true)},send);check(approvedFeedback().requests.length===0);
await handleFeedback({...input('a',`/feature approve ${r.id}`),forwarded:true},send);check(approvedFeedback().requests.length===0);
await handleFeedback({...input('a','yes, but change it'),replyToId:r.previewId},send);check(approvedFeedback().requests.length===0);
await handleFeedback({...input('a','yes'),replyToId:r.previewId},send);check(approvedFeedback().requests.length===1);
const exported=JSON.stringify(approvedFeedback());check(!exported.includes('447700'));check(!exported.includes('approvedAt'));check(!exported.includes('previewId'));
for(let i=0;i<100;i++)recordIssue('a','tool_failed');
check(JSON.stringify(approvedFeedback())===exported);check(readLedger('a').issues[0].count===100);
check(!fs.readdirSync(config.dataDir).some(x=>x.includes('feedback')||x.includes('reliability')));
const files=fs.readdirSync(config.reliabilityDir!);for(const f of files)check(!fs.readFileSync(path.join(config.reliabilityDir!,f),'utf8').includes('GIF'));
await handleFeedback(input('b',`/feedback withdraw ${r.id}`),send);check(approvedFeedback().requests.length===1);
applyFeedbackReceipts([{id:r.id,state:'proposed',pr:'https://github.com/example/example/pull/1'}]);check(readLedger('a').requests.at(-1)?.state==='proposed');check(readLedger('b').requests.length===0);
await handleFeedback(input('a',`/feedback withdraw ${r.id}`),send);check(approvedFeedback().requests.length===0);check(approvedFeedback().withdrawn.includes(r.id));
await handleFeedback({...input('a','feature'),replyToId:'quoted-other-person',quoteTopic:'controls'},send);
r=readLedger('a').requests.at(-1)!;check(r.description==='Provide direct music pause, next and seek controls alongside conversational control.');
check(!JSON.stringify(approvedFeedback()).includes(r.id));
await handleFeedback(input('a',`/feedback withdraw ${r.id}`),send);check(!approvedFeedback().withdrawn.includes(r.id));
await handleFeedback(input('a','/feedback off'),send);const before=sent.length;
await handleFeedback(input('a','It would be nice to add a GIF feature'),send,true);check(sent.length===before);
await handleFeedback(input('a','/feedback on'),send);
await handleFeedback(input('a','It would be nice to add a GIF feature'),send,true);check(sent.length===before+2);
const after=sent.length;await handleFeedback(input('a','It would be nice to add music controls feature'),send,true);check(sent.length===after);
check(!await handleFeedback(input('a','yes'),send,true));
for(const text of ['Include Alpha personal details','Expose sk-'+'x'.repeat(40),'Use https://example.com/private','Email reader@example.com','Call 447700900001','Use private address 192.168.5.9']){
 check(sensitiveDescription(text));const n=readLedger('a').requests.length;await handleFeedback(input('a','/bug '+text),send);check(readLedger('a').requests.length===n);
}
await handleFeedback(input('a','/bug A normal reply contained internal tool commands'),send);
r=readLedger('a').requests.at(-1)!;const ledger=readLedger('a');ledger.requests.at(-1)!.at-=31*60000;writeLedger('a',ledger);
await handleFeedback(input('a',`/bug approve ${r.id}`),send);check(!approvedFeedback().requests.some(x=>x.id===r.id));
const original=config.reliabilityDir;config.reliabilityDir=path.join(config.dataDir,'forbidden');assert.throws(()=>readLedger('a'));checks++;config.reliabilityDir=original;
fs.chmodSync(config.reliabilityKeyFile!,0o644);assert.throws(()=>readLedger('a'));checks++;fs.chmodSync(config.reliabilityKeyFile!,0o600);
check(feedbackTopic('declaration:default_api:forget')==='protocol');
await handleFeedback(input('b','/feature Support a cancellable series of voice walkthroughs'),send);const other=readLedger('b').requests.at(-1)!;
await handleFeedback(input('b',`/feature approve ${other.id}`),send);check(approvedFeedback().requests.some(x=>x.id===other.id));
const users=getUsers();saveUsers(users.filter(u=>u.id!=='b'));check(!approvedFeedback().requests.some(x=>x.id===other.id));saveUsers(users);
const announcements:{jid:string;text:string;id:string}[]=[];const announce=async(jid:string,text:string,id:string)=>{announcements.push({jid,text,id});};
await announceNext('fixture',announce);await announceNext('fixture',announce);await announceNext('fixture',announce);check(announcements.length===2);check(announcements.every(x=>x.text.includes('/mic')&&x.text.includes('/bug')&&x.text.includes('/feature')));
console.log(JSON.stringify({checks,realSends:0,networkCalls:0,approvedDescriptionExport:true,privateEventExport:false}));
'''

class FeedbackFlow(unittest.TestCase):
    def test_synthetic_flow(self):
        root=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='inkling-feedback-test-') as d:
            base=Path(d).resolve();data=base/'data';data.mkdir();store=base/'private';store.mkdir(mode=0o700)
            key=base/'key';key.write_text(base64.b64encode(os.urandom(32)).decode());key.chmod(0o600)
            (data/'users.json').write_text(json.dumps({'users':[{'id':'a','name':'Alpha','phone':'447700900001','timezone':'UTC'},{'id':'b','name':'Beta','phone':'447700900042','timezone':'UTC'}]}))
            env={'PATH':os.environ['PATH'],'HOME':d,'INKLING_DATA_DIR':str(data),'INKLING_RELIABILITY_DIR':str(store),'INKLING_RELIABILITY_KEY_FILE':str(key),'INKLING_SECRET_KEY':base64.b64encode(os.urandom(32)).decode()}
            fd,name=tempfile.mkstemp(prefix='zz-feedback-',suffix='.ts',dir=root/'src');os.close(fd);script=Path(name);script.write_text(SCRIPT)
            try:
                p=subprocess.run(['node','--import',str(root/'node_modules/tsx/dist/loader.mjs'),script],cwd=d,env=env,text=True,capture_output=True,timeout=60)
                self.assertEqual(p.returncode,0,p.stderr)
                result=json.loads(p.stdout);self.assertGreater(result['checks'],40);self.assertEqual(result['realSends'],0)
            finally: script.unlink(missing_ok=True)

if __name__=='__main__':unittest.main()
