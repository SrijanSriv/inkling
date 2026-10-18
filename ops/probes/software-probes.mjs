// Run in a separate process with an EMPTY scratch INKLING_DATA_DIR, never production data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.env.AUDIT_SOURCE_ROOT || '.');
const scratch = path.resolve(process.env.AUDIT_SCRATCH || '/not-configured');
assert.equal(path.resolve(process.env.INKLING_DATA_DIR || ''),scratch);
assert(scratch.includes('audit-probe-'));
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(scratch,'users.json'),'utf8')).users.map((u)=>u.id),['audit']);
const load = (file) => import(pathToFileURL(path.join(root,'src',file)).href);
const replies = await load('tool-replies.ts');
const dates = await load('dates.ts');
const watches = await load('watches.ts');
const links = await load('link-workflow.ts');
const audio = await load('article-audio.ts');
const vault = await load('vault.ts');
const store = await load('store.ts');
const result=[];
const record=(probe,passes)=>result.push({probe,result:passes?'pass':'fail'});
const declaration='declaration:default_api:article_voice_walkthrough{focus:,url:https://example.com/article}';
record('protocol_output',!replies.cleanToolReply(declaration).includes('declaration:default_api:'));
record('email_outcome',!!replies.unsupportedActionClaim('Drafted and sent.',[{name:'send_email',output:'The draft was shown; nothing was sent.'}]));
record('offer_followup',audio.articleOfferYes('yes. also answer if this can train small llms'));
dates.handleDate('date_add',{what:'Example',date:'05-01',remind_days_before:0},'audit','2026-01-01');
record('date_zero',vault.readSealedJson(store.chatFile('audit','dates.json'),[])[0].remindDaysBefore===0);
const invalid=dates.handleDate('date_add',{what:'Invalid example',date:'13-40',remind_days_before:3},'audit','2026-01-01');
record('date_invalid',!invalid.startsWith('Saved.'));
const beforeRemoval=vault.readSealedJson(store.chatFile('audit','dates.json'),[]).length;
dates.handleDate('date_remove',{what:''},'audit','2026-01-01');
record('date_empty_remove',vault.readSealedJson(store.chatFile('audit','dates.json'),[]).length===beforeRemoval&&beforeRemoval>0);
watches.handleWatch('watch_add',{what:'Public fixture',every:'3h'},'audit','audit');
const first=watches.takeDueWatches('audit');
record('watch_completion',first.length===1&&watches.takeDueWatches('audit').length===1);
links.configureLinkWorkflow('audit','audit',false,{action:'set',senders:'self',list:'links',language:'English',words:50},'enable automatically summarize links');
assert(links.reserveLink('audit','audit','synthetic-message'));
const dependencies={
 read:async()=>`Page content from https://example.com/article (written by someone else):\n\n${'Public synthetic content. '.repeat(20)}`,
 summarize:async()=>'A public synthetic summary.'
};
const prepared=await links.runLinkWorkflow('audit','audit','synthetic-message','https://example.com/article',undefined,dependencies);
assert(prepared?.includes('A public synthetic summary.'));
const retry=await links.runLinkWorkflow('audit','audit','synthetic-message','https://example.com/article',undefined,dependencies);
record('link_delivery',typeof retry==='string'&&retry.includes('A public synthetic summary.'));
record('reminder_evidence',!!replies.unsupportedActionClaim("I'll remind you tomorrow",[{name:'list_reminders',output:'No reminders set here.'}]));
// Approval safety and restart durability, with a fake draft and no sending API.
const drafts = await load('drafts.ts');
record('email_conditional_approval',!drafts.mailApproval('yes, but change the subject'));
record('draft_expiry',drafts.draftExpired({createdAt:Date.now()-31*60000}));
drafts.drafts.set('audit',{kind:'email',to:'reader@example.com',name:'Reader',text:'Synthetic draft only.',createdAt:Date.now()});
const {execFile}=await import('node:child_process');
const recovered=(await new Promise((resolve,reject)=>execFile(process.execPath,['--import',path.join(root,'node_modules/tsx/dist/loader.mjs'),'--input-type=module','-e',
  `const {drafts}=await import(${JSON.stringify(pathToFileURL(path.join(root,'src/drafts.ts')).href)});process.stdout.write(drafts.has('audit')?'yes':'no');`],{cwd:scratch,env:process.env,timeout:15000,encoding:'utf8'},(error,stdout)=>error?reject(error):resolve(stdout)))).trim();
record('draft_restart',recovered==='yes');
// One fixed marker, consumed by the wrapper. Imported code may write synthetic logger events.
console.log('AUDIT_PROBES='+JSON.stringify(result));
