// Trusted closed schema, shared by the model adapter and independent Python receiver.
export const PROBES = Object.freeze(['protocol_output','email_outcome','offer_followup','date_zero','date_invalid','date_empty_remove','watch_completion','link_delivery','reminder_evidence']);
const exact=(x,keys)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export function validateReport(value) {
  const invalid=()=>{throw new Error('Invalid strict software report');};
  if(!exact(value,['schema','suite','results'])||value.schema!==1||value.suite!=='software-probes-v1'||!Array.isArray(value.results)||value.results.length!==PROBES.length) invalid();
  const found=new Map();
  for(const row of value.results) {
    if(!exact(row,['probe','result'])||!PROBES.includes(row.probe)||found.has(row.probe)||!['pass','fail','unsupported'].includes(row.result)) invalid();
    found.set(row.probe,row.result);
  }
  return {schema:1,suite:'software-probes-v1',results:PROBES.map(probe=>({probe,result:found.get(probe)}))};
}
export function probeOutput(text) {
  const rows=String(text).split('\n').filter(s=>s.startsWith('AUDIT_PROBES='));
  if(rows.length!==1) throw new Error('Missing synthetic probe result');
  return validateReport({schema:1,suite:'software-probes-v1',results:JSON.parse(rows[0].slice('AUDIT_PROBES='.length))});
}
export function reviewInput(report, baseline, context) {
  return `Review the latest default-branch source using the fixed public synthetic suite. Fix justified issues; do not invent a change simply to open a PR.\nExisting public maintenance PR context:\n${JSON.stringify(context)}\nPi synthetic report (older source, no private inputs):\n${JSON.stringify(validateReport(report))}\nFresh current-source synthetic baseline (use this for fixes):\n${JSON.stringify(validateReport(baseline))}`;
}
