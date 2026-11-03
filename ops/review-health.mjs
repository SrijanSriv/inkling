// Closed diagnostic categories only. Raw server errors and model messages never leave memory.
export function category(error) {
  const text = JSON.stringify(error ?? '').toLowerCase();
  if (/usage.?limit|quota|rate.?limit/.test(text)) return 'quota';
  if (/unauthor|authentication|access.token|refresh.token|\b401\b/.test(text)) return 'authentication';
  if (/model.*(?:not.?found|unsupported|not.?support|not.?access|does.?not.?exist)/.test(text)) return 'model';
  if (/schema|invalid.?request|\b400\b/.test(text)) return 'request_schema';
  if (/timed.out|timeout|exceeded/.test(text)) return 'timeout';
  if (/sandbox|private.path.visible|network.visible/.test(text)) return 'sandbox';
  if (/disconnect|connection.closed/.test(text)) return 'disconnected';
  if (/connect|stream|network|dns/.test(text)) return 'transport';
  return 'other';
}
export function turnFailure(msg) {
  if (msg.method === 'error') return category(msg.params?.error);
  if (msg.method === 'turn/completed' && msg.params?.turn?.status !== 'completed') return category(msg.params?.turn?.error);
}
