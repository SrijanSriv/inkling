import { randomBytes } from "node:crypto";
import { getUsers } from "./config.js";
import { feedbackEnabled, readLedger, writeLedger, type Request } from "./reliability-store.js";

export const TOPICS = {
  protocol: "Prevent internal tool commands and status receipts from appearing in assistant replies.",
  music: "Make music playback, queue changes and playback status agree with the actual player result.",
  link: "Make link summaries and saving reliable, including delivery retries and source-grounded follow-up answers.",
  reminder: "Make reminders and scheduled work preserve the requested time and report their actual completion.",
  memory: "Make explicit memory corrections persist and ensure replies use the corrected saved information.",
  mail: "Keep email draft, approval, send and reply status distinct and reliable.",
  browser: "Make browser tasks resume reliably and clearly report blocked or unfinished steps.",
  voice: "Improve voice capture, transcription and spoken reply reliability without losing words.",
  gif: "Support optional relevant GIF and sticker replies.",
  controls: "Provide direct music pause, next and seek controls alongside conversational control.",
  series: "Support an ordered, cancellable series of article audio walkthroughs.",
} as const;
export type Topic = keyof typeof TOPICS;
export function feedbackTopic(text: string): Topic | undefined {
  if (/declaration:|default_api|tool_call|system message|internal command|completed\)/i.test(text)) return "protocol";
  if (/gif|sticker/i.test(text)) return "gif";
  if (/seek|slider|music controls/i.test(text)) return "controls";
  if (/series|linked pages/i.test(text)) return "series";
  if (/music|song|queue|speaker/i.test(text)) return "music";
  if (/remind|schedule|date|yaad/i.test(text)) return "reminder";
  if (/memory|remember|forget/i.test(text)) return "memory";
  if (/email|gmail|mail/i.test(text)) return "mail";
  if (/browser|browsing|website/i.test(text)) return "browser";
  if (/voice|audio|mic|transcri/i.test(text)) return "voice";
  if (/link|article|summary|summar/i.test(text)) return "link";
}
export function sensitiveDescription(text: string): boolean {
  if (text.length < 10 || text.length > 600 || /@|https?:|www\.|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:[A-Fa-f0-9]{1,4}:){2,}|\S+@\S+|(?:\+?\d[\s()-]*){7,}|[A-Za-z0-9_-]{28,}|api.?key|password|bearer|-----BEGIN|\/home\/|\/Users\/|\.local\b|[{}<>`]|\b(?:ignore (?:previous|all)|system prompt|exfiltrat)\b/i.test(text)) return true;
  return getUsers().some(u => u.name.split(/\s+/).some(name => name.length >= 3 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)));
}
const current = (id: string) => getUsers().some(u => u.id === id);
const fullPreview = (r: Request) => `${r.kind === "bug" ? "Bug report" : "Feature request"} ${r.id}\n\n${r.description}\n\nAdd this exact wording to the improvement list? It will be sent to Codex/OpenAI on the laptop and may appear in a PUBLIC GitHub PR. No quoted message or chat history is attached. Only approve your own description, without anyone's private details.\n\nReply yes to THIS message, or send /${r.kind} approve ${r.id}. To cancel: /feedback withdraw ${r.id}. Approval expires in 30 minutes.`;
export type FeedbackInput = { actor: string; chat: string; text: string; id: string; at: number; group: boolean; plain: boolean; forwarded: boolean; replyToId?: string; quoteTopic?: Topic };
export function feedbackBoundary(text: string, replyToId?: string): boolean {
  return /^\/(?:bug|feature|feedback)(?:\s|$)/i.test(text.trim()) || !!replyToId && /^(?:bug|feature)$/i.test(text.trim()) || !!replyToId?.startsWith("INKFEED");
}
export async function handleFeedback(input: FeedbackInput, sendPrivate: (text: string, id?: string) => Promise<void>, automatic = false): Promise<boolean> {
  if (!current(input.actor)) return false;
  if (!input.plain || input.forwarded) {
    if (feedbackBoundary(input.text, input.replyToId)) { await sendPrivate("Please type a direct /bug or /feature request yourself. Forwarded messages and audio cannot approve sharing."); return true; }
    return false;
  }
  const text = input.text.trim(), explicit = feedbackBoundary(text, input.replyToId);
  if (!explicit && !automatic) return false;
  if (!feedbackEnabled()) { if (explicit) await sendPrivate("Feedback is not configured yet."); return explicit; }
  const ledger = readLedger(input.actor);
  if (ledger.seen.includes(input.id)) return explicit;
  const mark = () => { ledger.seen = [...ledger.seen, input.id].slice(-200); writeLedger(input.actor, ledger); };
  const approval = /^\/(?:bug|feature) approve ([BF][A-F0-9]{12})$/i.exec(text);
  const pending = ledger.requests.find(r => approval ? r.id === approval[1].toUpperCase() : r.previewId === input.replyToId);
  if (approval || input.replyToId?.startsWith("INKFEED")) {
    if (!pending) { await sendPrivate("That preview is unavailable in your own request list. Use /feedback to check it."); mark(); return true; }
    if (input.group) { await sendPrivate("Please approve this request in our private chat."); return true; }
    if (/^(?:yes|yeah|yep|haan|ha|sure|ok|okay)[.!\s]*$/i.test(text) || approval) {
      if (pending.state !== "preview") { await sendPrivate(`Request ${pending.id} is ${pending.state}.`); mark(); return true; }
      if (Date.now() - pending.at > 30 * 60000 || input.at + 1000 < pending.at || sensitiveDescription(pending.description)) { await sendPrivate("That preview expired or needs rewriting. Submit a new general description."); return true; }
      pending.state = "approved"; pending.approvedAt = Date.now(); mark();
      await sendPrivate(`Added ${pending.id} to the ${pending.kind} list for nightly review. /feedback shows status; /feedback withdraw ${pending.id} stops future sharing. This is a request, not a promise it will be built.`);
    } else await sendPrivate("Nothing added. Use /bug or /feature with your revised wording, or /feedback withdraw followed by the request ID.");
    return true;
  }
  const control = /^\/feedback(?:\s+(on|off|list|status|issues|withdraw)(?:\s+([BF][A-F0-9]{12}))?)?$/i.exec(text);
  if (control || /^\/(?:bug|feature) (?:list|status)$/i.test(text)) {
    const action = control?.[1]?.toLowerCase();
    if(action === "issues") { await sendPrivate(ledger.issues.length ? "Local technical candidates, not confirmed bugs. These counts are NOT sent to Codex:\n"+ledger.issues.map(i=>`${i.code.replaceAll("_"," ")}: ${i.count}`).join("\n") : "No recent local technical candidates in your private chat. These checks never export chat contents or counts.");mark();return true; }
    if (action === "on" || action === "off") { ledger.prompts = action === "on"; mark(); await sendPrivate(`Feature suggestion prompts are ${action}. Explicit /bug and /feature still work. Local technical checks never send chat contents.`); return true; }
    if (action === "withdraw") {
      const found = ledger.requests.find(r => r.id === control?.[2]?.toUpperCase());
      if (found) { found.state = "withdrawn"; mark(); }
      await sendPrivate(found ? `Withdrawn ${found.id}. Future runs will exclude it. Information already reviewed or published cannot be recalled automatically.` : "No matching request in your own list."); return true;
    }
    const labels: Record<string,string> = {preview:"waiting for your approval",approved:"approved, waiting for transfer",sent:"queued on the laptop",withdrawn:"withdrawn",proposed:"PR proposed, not deployed",needs_info:"needs more detail; submit a new general description",deferred:"deferred for another review"};
    const onlyKind=/^\/(bug|feature) (?:list|status)$/i.exec(text)?.[1]?.toLowerCase();
    const rows = ledger.requests.filter(r=>!onlyKind||r.kind===onlyKind).slice(-15).map(r => `${r.id} · ${r.kind} · ${labels[r.state] ?? r.state}: ${r.description}${r.pr ? `\n${r.pr}` : ""}`);
    await sendPrivate(rows.length ? rows.join("\n\n") : "Your request list is empty. Use /bug or /feature followed by a short general description. A preview and your approval come before sharing."); mark(); return true;
  }
  if (/^\/(?:feedback|(?:bug|feature)\s+(?:approve|withdraw))\b/i.test(text)) { await sendPrivate("Use /feedback to list requests, /feedback withdraw <ID> to cancel, or the exact approval command on your preview. Nothing was shared."); return true; }
  const command = /^(?:\/(bug|feature)|(?:(bug|feature))$)(?:\s+([\s\S]*))?$/i.exec(text);
  let kind: "bug" | "feature" = command?.[1]?.toLowerCase() === "bug" || command?.[2]?.toLowerCase() === "bug" ? "bug" : "feature";
  let description = command?.[3]?.trim();
  if (!command) {
    if (!automatic || !ledger.prompts || Date.now() - ledger.lastOffer < 86400000 || !/\b(?:feature request|would be nice|wish you could|can you add support|could you add support|can we add|new ability|(?:please|want|add|support|build|make).{0,35}feature)\b/i.test(text)) return false;
    const topic = feedbackTopic(text);
    description = topic ? TOPICS[topic] : text; ledger.lastOffer = Date.now();
  }
  if (!description && input.quoteTopic) description = TOPICS[input.quoteTopic];
  if (!description) { await sendPrivate("Send /bug or /feature followed by a general description, or reply to a message with the command. Quoted text is never copied into a report; you will review a fresh description first."); return true; }
  if (sensitiveDescription(description)) { await sendPrivate("Please rewrite this as a short general software request: no names, contact details, links, passwords, tokens, raw tool output or quotations. Nothing has been shared."); return true; }
  if (ledger.requests.filter(r => ["preview", "approved", "sent", "deferred"].includes(r.state)).length >= 20) { await sendPrivate("Your open request list is full. Use /feedback to review or withdraw old requests first."); return true; }
  const existing = ledger.requests.find(r => r.kind === kind && r.description === description && ["preview", "approved", "sent"].includes(r.state));
  if (existing && existing.state !== "preview") { await sendPrivate(`Already in your list as ${existing.id} (${existing.state}).`); return true; }
  const r: Request = existing ?? { id: (kind === "bug" ? "B" : "F") + randomBytes(6).toString("hex").toUpperCase(), kind, description, state: "preview", at: Date.now(), previewId: "INKFEED" + randomBytes(12).toString("hex").toUpperCase() };
  if (!existing) ledger.requests.push(r);
  mark(); await sendPrivate(fullPreview(r), r.previewId);
  return true;
}
