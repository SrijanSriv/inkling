import { config, getUsers } from "./config.js";
import { googleAccounts } from "./google.js";

export type MailSender = { userId: string; email: string; shared: boolean };

/** Credentials stay with the connecting user. Sharing grants sending only, checked again at confirmation. */
export function sharedMailSender(userId: string, groupId?: string): MailSender | undefined {
  const users = getUsers();
  if (!users.some(u => u.id === userId) || !config.mailUserId || !config.mailAccount) return;
  if (groupId && !config.mailGroups.includes(groupId)) return;
  if (!users.some(u => u.id === config.mailUserId)) return;
  const account = googleAccounts(config.mailUserId).find(a => a.gmail && a.email.toLowerCase() === config.mailAccount);
  if (account) return { userId: config.mailUserId, email: account.email, shared: true };
}

export function mailSender(userId: string, groupId?: string, account?: string, mode: "either" | "shared" | "personal" = "either"): MailSender | undefined {
  if (!getUsers().some(u => u.id === userId)) return;
  const wanted = account?.trim().toLowerCase();
  if (mode !== "personal") {
    const shared = sharedMailSender(userId, groupId);
    if (shared && (!wanted || wanted === shared.email.toLowerCase())) return shared;
    if (mode === "shared") return;
  }
  // Personal accounts remain usable only by their owner, privately.
  if (groupId) return;
  const own = googleAccounts(userId).find(a => a.gmail && (!wanted || a.email.toLowerCase() === wanted));
  if (own) return { userId, email: own.email, shared: false };
}
