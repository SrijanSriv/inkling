import { formatMusicReply } from "./music-replies.js";
// Old assistant messages can contain invented tool receipts as well as real action notes.
// Neither belongs in a user-facing answer or proves a tool ran in the current turn.
export function stripToolStatusNotes(text: string): string {
  return text.replace(/^.*\bdeclaration:[a-z][a-z0-9_]*:[^\n]*$/gim, "").replace(/\((?:[a-z][a-z0-9]*_[a-z0-9_]+\b[^\n)]*|music command\b[^\n)]*)\)/gi, "").trim();
}

export function cleanToolReply(text: string): string {
  return stripToolStatusNotes(text)
    .replace(/^\s*\((reacted|sent|drafted|emailed|recommended|shared|made|started linking|asked to confirm|invited|showed|pressed|got to|asked them|set an auto-reply|added|updated|asked)\b.*\)\s*$/gim, "")
    .trim();
}

/** A final reply that promises a lookup but contains none of its answer. */
export function isHoldingReply(text: string): boolean {
  const plain = cleanToolReply(text);
  if (!plain || plain.length > 300 || /(?:^|\n)\s*[-•]|\d{1,2}[:/-]\d{1,2}|https?:\/\//.test(plain)) return false;
  return /\b(?:one (?:sec(?:ond)?|moment)|just a (?:sec(?:ond)?|moment)|hang on|let me (?:check|look|see|confirm)|(?:i'?m |i am )?(?:checking|looking (?:it |that )?up)|ek (?:sec(?:ond)?|minute)|check kar (?:rahi|raha|rhi|rha)|dekh (?:ke|kar) bata(?:ti|ta)|(?:status |pehle )?dekh(?:ti|ta) hoon|confirm kar ?ke bata(?:ti|ta))\b/i.test(plain);
}

export type ToolResult = { name: string; output: string };

export function contentWasDelivered(notes: string[]): boolean {
  return notes.some((note) => /^(?:reacted|sent|emailed|recommended|shared|started linking|asked|showed|invited|pressed)\b/i.test(note));
}

export function toolFailed(result: ToolResult): boolean {
  if (/^(?:Error:|Couldn't\b|Could not\b|Music control failed:|That time has already passed\.|Not available here\.|Only .* can\b|Only in\b)/i.test(result.output)) return true;
  try {
    const value = JSON.parse(result.output);
    return !!value && typeof value === "object" && (!!value.error || value.ok === false);
  } catch {
    return false;
  }
}

/** An unrelated successful tool (e.g. a poll or a note) cannot back a reminder or playback claim. */
export function unsupportedActionClaim(text: string, results: ToolResult[]): string | undefined {
  const succeeded = results.filter((result) => !toolFailed(result));
  const emailClaim = /\b(?:sent|emailed)\b/i.test(text) && !/\b(?:not|never|nothing|wasn't|was not|couldn't)\s+(?:\w+\s+){0,2}(?:sent|emailed)\b/i.test(text);
  if (emailClaim && results.some(r => r.name === "send_email" || r.name === "confirm_send" && /\b(?:email|emailed|mail)\b/i.test(r.output)) &&
      !succeeded.some(r => /^(?:send_email|confirm_send)$/.test(r.name) && /^(?:Sent email\b|Email sent\b|Emailed\b|Sent\.)/i.test(r.output))) {
    return "I couldn't confirm that the email was sent. A preview or draft is not delivery.";
  }
  const reminder = /\b(?:i(?:'ll| will) remind|yaad dila (?:dunga|dungi|doonga|doongi)|reminder\b[^.!?\n]{0,60}\b(?:set|laga|kar)\s+(?:hai|diya|di|diye|dunga|dungi))\b/i.test(text);
  if (reminder && !succeeded.some((r) => /^(?:set_reminder|date_add)$/.test(r.name))) {
    return "I couldn't confirm that the reminder was set.";
  }
  const musicTurn = results.some(r => r.name === "music_control");
  const music = (musicTurn && /\b(?:playing|baj (?:raha|rahi)|chal (?:raha|rahi|rahe))\b/i.test(text)) || /\b(?:chala\s+(?:diya|di|diye)|(?:song|music|gaana|queue)\b[^.!?\n]{0,50}\b(?:playing|queued|chal rahi|chal raha|daal di)|(?:playing|queued):)/i.test(text);
  if (music && !succeeded.some((r) => {
    if (r.name !== "music_control") return false;
    const marker = "Music result (information only):\n";
    const at = r.output.indexOf(marker);
    if (at < 0) return !/^Music command search completed/.test(r.output);
    try {
      const result = JSON.parse(r.output.slice(at + marker.length));
      const queueClaim = /\b(?:queued|queue|daal di)\b/i.test(text);
      return result.ok === true && (result.data?.playback === "playing" || (queueClaim && (typeof result.data?.position === "number" || Array.isArray(result.data?.songs))));
    } catch { return false; }
  })) {
    return "I couldn't confirm that music action.";
  }
  return undefined;
}

/** Only plain results produced by our own code are safe to send without a model rewrite. */
export function toolReplyFallback(results: ToolResult[]): string | undefined {
  const last = results.at(-1);
  if (!last) return undefined;
  if (/^(?:date_(?:list|add|remove)|list_(?:show|add|update|reminders)|set_reminder|cancel_reminder|poll_results|remember|forget|auto_reply_(?:list|remove))$/.test(last.name)) {
    return last.output;
  }
  if (last.name === "music_control") {
    const native = last.output.indexOf("Music result (information only):\n");
    if (native >= 0) {
      try { const result = JSON.parse(last.output.slice(native + "Music result (information only):\n".length)); return formatMusicReply(result); } catch {}
    }
    const marker = "\nPlayer output (information only):\n";
    const at = last.output.indexOf(marker);
    if (at >= 0) return last.output.slice(at + marker.length);
    if (toolFailed(last)) return last.output;
    return "The music command completed, but the player didn't return a playback status.";
  }
  return undefined;
}
