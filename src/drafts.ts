// Things waiting for a person's yes before they happen: a WhatsApp message as them, an email, a Google invite,
// the final step on a website (pay, book, submit), or a change to the assistant itself. Code shows them exactly what will happen; confirm_send (agent.ts) only acts in a
// later message that starts with a yes, before the draft expires. Kept in memory, one per person.

export type Draft = {
  kind: "whatsapp" | "email" | "invite" | "change" | "deploy" | "undo" | "web";
  /** WhatsApp jid, email address, event id or change id. */
  to: string;
  name: string;
  subject?: string;
  from?: string;
  /** Shared assistant mail is re-authorized for this requester and originating group before sending. */
  emailShared?: boolean;
  emailGroupId?: string;
  /** An API message id, never a model-invented SMTP header. Revalidated at send time. */
  emailReplyMessageId?: string;
  emailReviewId?: string;
  text: string;
  /** For a Google Calendar invite: the call to make once they say yes. */
  invite?: Record<string, unknown>;
  createdAt: number;
  /** How long the yes counts for; 30 minutes unless set. */
  ttlMs?: number;
};

export const drafts = new Map<string, Draft>();

export const YES = /^\s*(yes|yeah|yep|yup|ya|y|sure|ok|okay|send( it)?|go( ahead)?|do it|deploy( it)?|please do|👍|✅)\b/i;

export const draftExpired = (d: Draft) => Date.now() - d.createdAt > (d.ttlMs ?? 30 * 60_000);

/** A yes with edits/conditions must never send the old email. */
export function mailApproval(text: string, reviewId?: string): boolean {
  const words = text.replace(/^\[[^\]]*\]\s*/gm, "").trim();
  const named = words.match(/\bM\d+\b/gi) || [];
  if (named.some(id => id.toUpperCase() !== reviewId)) return false;
  return /^(?:(?:yes|yeah|yep|yup|sure|ok|okay)(?:[,\s]+(?:please\s+)?(?:send|email|reply)(?:\s+(?:it|that|this|the email|the reply|email|mail|reply))?(?:\s+M\d+)?)?|send(?:\s+(?:it|the email|the reply|email|mail))?(?:\s+M\d+)?|go ahead)[\s.!]*$/i.test(words);
}
