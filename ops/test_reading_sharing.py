"""Real encrypted outbox/budget behavior with synthetic articles and callback-only delivery."""
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
import {createHash} from 'node:crypto';
import {config,saveUsers} from './config.js';
import {chatFile} from './store.js';
import {readSealedJson,writeSealedJson} from './vault.js';
import {prepareReadingShares,deliverReadingShare,readingSharingStatus} from './reading-sharing.js';
saveUsers([{id:'reader',name:'Example',phone:'447700900001',admin:true,owner:true,timezone:'Asia/Kolkata'}]);
fs.mkdirSync(path.dirname(chatFile('group-1234567890','history.json')),{recursive:true});
Object.assign(process.env,{INKLING_READING_SHARE_GROUP:'group-1234567890',INKLING_READING_SHARE_BY:'reader',INKLING_READING_SHARE_SINCE:'2026-01-01T00:00:00Z',INKLING_READING_TIMEZONE:'Asia/Kolkata',INKLING_READING_DAILY:'50'});
const root=path.join(config.dataDir,'reading'), summary=Array.from({length:50},(_,i)=>'word'+i).join(' ');
const local=(day:number,hour:number)=>Date.parse(`2026-01-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:00:00+05:30`);
let now=local(2,10),checks=0,sent:{at:number;text:string}[]=[];
const check=(ok:unknown)=>{assert(ok);checks++;};
const reset=()=>{fs.rmSync(root,{recursive:true,force:true});sent=[];delete process.env.INKLING_READING_SHARE_DAILY;delete process.env.INKLING_READING_SHARE_MIN_SCORE;now=local(2,10);};
const ids=(n:number)=>{const article=createHash('sha256').update('article'+n).digest('hex');return {article,id:createHash('sha256').update('group-1234567890:'+article).digest('hex')};};
const shareFile=(n:number)=>path.join(root,'shares',ids(n).id+'.json');
const note=(n:number,at=now,partial=false)=>{const {article}=ids(n);writeSealedJson(path.join(root,'articles',article+'.json'),{id:article,url:`https://example.com/article/${n}`,title:'Public synthetic idea '+n,readAt:at,coverage:partial?'partial':'extracted-text',sections:[{summary:'Public synthetic article notes with concrete evidence.'}]});};
const ready=(n:number,at=now,score=9,legacy=false)=>{const {article,id}=ids(n);writeSealedJson(shareFile(n),{id,article,group:'group-1234567890',by:'reader',readAt:at,created:at,next:0,attempts:1,status:'ready',summary,url:`https://example.com/article/${n}`,partial:false,...(!legacy?{selection:{version:1,score}}:{})});};
const deps={connected:()=>true,permitted:async()=>true,now:()=>now,send:async(_g:string,text:string)=>{sent.push({at:now,text});}};
const deliver=()=>deliverReadingShare(deps);
const prep=(decision:unknown)=>prepareReadingShares({now:()=>now,summarize:async()=>JSON.stringify(decision)});
const approved={share:true,score:9,reason:'standout',summary};
// Reading quota cannot raise sending quota; persisted budgets survive repeated invocations.
reset();for(let n=0;n<20;n++)ready(n);
await deliver();check(sent.length===1);await deliver();check(sent.length===1);
now=local(2,15);await deliver();check(sent.length===1);
now=local(2,16);await deliver();check(sent.length===2);
now=local(2,20);await deliver();check(sent.length===2);check(readingSharingStatus().dailyLimit===2);
// Midnight is not a loophole: two previous-day sends still consume the rolling 24-hour cap.
reset();now=local(2,14);for(let n=0;n<5;n++)ready(n);await deliver();now=local(2,20);await deliver();check(sent.length===2);
now=local(3,10);await deliver();check(sent.length===2);now=local(3,14);await deliver();check(sent.length===3);
for(let i=0;i<sent.length;i++)check(sent.filter(s=>s.at>sent[i].at-86400000&&s.at<=sent[i].at).length<=2);
// Quiet hours and an async permission check crossing the cutoff cannot send.
for(const hour of [0,3,9,21,23]){reset();now=local(2,hour);ready(1);await deliver();check(sent.length===0);}
reset();now=local(2,20);ready(1);await deliverReadingShare({...deps,permitted:async()=>{now=local(2,21);return true;}});check(sent.length===0);
// Old/unchecked queues and partial/old notes never trickle out under the new policy.
reset();ready(1,now,9,true);await deliver();check(sent.length===0);
await prepareReadingShares({now:()=>now,summarize:async()=>{throw Error('No eligible note should call a model');}});check(sent.length===0);
reset();ready(1,now-49*3600000);await deliver();check(sent.length===0);
reset();note(1,now,true);await prep(approved);await deliver();check(sent.length===0);check(readingSharingStatus().skipped===1);
reset();note(1,now-49*3600000);let calls=0;await prepareReadingShares({now:()=>now,summarize:async()=>{calls++;return JSON.stringify(approved);}});check(calls===0);
// A low score, rejection, routine content, or invalid response is never published. Notes remain.
for(const decision of [{...approved,share:false,summary:''},{...approved,score:8},{...approved,reason:'routine'}]){
 reset();note(1);await prep(decision);await deliver();check(sent.length===0);check(readingSharingStatus().skipped===1);
 check(fs.existsSync(path.join(root,'articles',ids(1).article+'.sealed')));
}
reset();note(1);await prep({...approved,summary:'too short'});await deliver();check(sent.length===0);
// Good notes are selected; legacy queued material is re-evaluated, not grandfathered in.
reset();note(1);ready(1,now,9,true);await prep(approved);await deliver();check(sent.length===1);check(sent[0].text.endsWith('https://example.com/article/1'));
reset();ready(1,now,9);ready(2,now-1000,10);await deliver();check(sent[0].text.endsWith('https://example.com/article/2'));
reset();ready(1);process.env.INKLING_READING_SHARE_MIN_SCORE='10';await deliver();check(sent.length===0);
// Failed/uncertain sends consume quota and cannot be automatically retried.
reset();now=local(2,14);for(let n=0;n<4;n++)ready(n);let attempts=0;
const fail=async()=>deliverReadingShare({...deps,send:async()=>{attempts++;throw Error('synthetic transport uncertainty');}});
await fail();now=local(2,20);await fail();now=local(3,10);await fail();check(attempts===2);check(readingSharingStatus().uncertain===2);
// An upgrade preserves existing sent receipts and old budgets, including uncertain attempts.
reset();for(let n=0;n<3;n++)ready(n);for(let n=0;n<2;n++){const s=readSealedJson<Record<string,unknown>>(shareFile(n),{});writeSealedJson(shareFile(n),{...s,status:'sent',sentAt:local(2,10+n)});}now=local(2,20);await deliver();check(sent.length===0);
reset();ready(1);writeSealedJson(path.join(root,'delivery-budget.json'),{day:'2026-01-01',attempts:2,lastAttempt:local(1,20)});await deliver();check(sent.length===0);
// Configuration cannot increase the hard ceiling; zero pauses only broadcasts, not reading.
reset();ready(1);process.env.INKLING_READING_SHARE_DAILY='3';await assert.rejects(deliver);checks++;check(sent.length===0);
process.env.INKLING_READING_SHARE_DAILY='0';await deliver();check(sent.length===0);
reset();ready(1);await deliverReadingShare({...deps,permitted:async()=>false});check(sent.length===0);check(!fs.existsSync(path.join(root,'delivery-budget.sealed')));
reset();ready(1);await Promise.all([deliver(),deliver()]);check(sent.length===1);
console.log('READING_CHECKS='+JSON.stringify({checks,realSends:0,networkCalls:0}));
'''

class ReadingSharing(unittest.TestCase):
    def test_quiet_selective_bounded_sharing(self):
        root=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='inkling-sharing-test-') as d:
            data=Path(d)/'data';data.mkdir();(data/'users.json').write_text('{"users":[]}')
            env={'PATH':os.environ['PATH'],'HOME':d,'INKLING_DATA_DIR':str(data),'INKLING_SECRET_KEY':base64.b64encode(os.urandom(32)).decode()}
            fd,name=tempfile.mkstemp(prefix='zz-reading-sharing-',suffix='.ts',dir=root/'src');os.close(fd);script=Path(name);script.write_text(SCRIPT)
            try:
                p=subprocess.run(['node','--import',str(root/'node_modules/tsx/dist/loader.mjs'),script],cwd=d,env=env,text=True,capture_output=True,timeout=60)
                self.assertEqual(p.returncode,0,p.stderr)
                rows=[line.removeprefix('READING_CHECKS=') for line in p.stdout.splitlines() if line.startswith('READING_CHECKS=')]
                result=json.loads(rows[0]);self.assertGreaterEqual(result['checks'],40);self.assertEqual(result['realSends'],0)
            finally:script.unlink(missing_ok=True)

if __name__=='__main__':unittest.main()
