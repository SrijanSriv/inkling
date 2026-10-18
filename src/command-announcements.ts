import path from "node:path";
import { config, getUsers, type User } from "./config.js";
import { commandHelp } from "./command-help.js";
import { readSealedJson, writeSealedJson } from "./vault.js";
import { log } from "./log.js";
// Operator opt-in for a specific rollout, not every restart. Sends through the one live connection.
export async function announceNext(version: string, send: (jid: string, text: string, id: string) => Promise<void>, eligible: (user: User) => boolean = () => true): Promise<void> {
  const file = path.join(config.dataDir, "command-announcements.json");
  const sent = readSealedJson<Record<string, string>>(file, {});
  const user = getUsers().find(u => sent[u.id] !== version && eligible(u));
  if (!user) return;
  const { createHash } = await import("node:crypto");
  const id = "INKHELP" + createHash("sha256").update(version + ":" + user.id).digest("hex").slice(0, 24).toUpperCase();
  await send(`${user.phone}@s.whatsapp.net`, `New command guide from ${config.name}\n\n${commandHelp(user)}\n\nPrivate technical records stay local and are not sent to Codex. Only the exact bug/feature wording you approve is shared with Codex and may become public in a GitHub PR. I never attach your chat history.`, id);
  sent[user.id] = version; writeSealedJson(file, sent);
}
export function startCommandAnnouncements(connected: () => boolean, send: (jid: string, text: string, id: string) => Promise<void>): void {
  const version = process.env.INKLING_COMMAND_ANNOUNCEMENT;
  if (!version || !/^[a-z0-9-]{1,40}$/.test(version)) return;
  let busy = false;
  const retry = new Map<string,number>();
  const attempts: number[] = [];
  const tick = async () => {
    while(attempts.length && attempts[0]<Date.now()-3600000)attempts.shift();
    if (busy || !connected() || attempts.length>=30) return;
    busy = true;
    try { await announceNext(version,async(jid,text,id)=>{attempts.push(Date.now());try{await send(jid,text,id);}catch(error){retry.set(jid,Date.now()+5*60000);throw error;}},user=>(retry.get(`${user.phone}@s.whatsapp.net`)??0)<Date.now()); }
    catch { log.warn("command guide delivery delayed"); }
    finally { busy = false; }
  };
  setInterval(() => void tick(), 15000).unref(); void tick();
}
