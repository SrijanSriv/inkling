// Trusted local maintenance adapter. No chat reading, model calls or network. Approved descriptions only.
import { getUsers } from "./config.js";
import { sensitiveDescription } from "./feedback.js";
import { feedbackEnabled, readLedger, writeLedger } from "./reliability-store.js";
export function approvedFeedback() {
  const requests: { id: string; kind: "bug" | "feature"; description: string }[] = [], withdrawn: string[] = [];
  if (feedbackEnabled()) for (const user of getUsers()) {
    const ledger = readLedger(user.id);
    for (const r of ledger.requests) {
      if (r.state === "withdrawn") { if(r.approvedAt)withdrawn.push(r.id); continue; }
      if (!["approved", "sent", "deferred"].includes(r.state) || !r.approvedAt || sensitiveDescription(r.description)) continue;
      requests.push({ id: r.id, kind: r.kind, description: r.description });
    }
  }
  if (requests.length > 100 || withdrawn.length > 500) throw new Error("Feedback export exceeds bounds.");
  return { schema: 1, suite: "approved-feedback-v1", requests: requests.sort((a,b) => a.id.localeCompare(b.id)), withdrawn: withdrawn.sort() };
}
export function applyFeedbackReceipts(input: unknown): void {
  if (!Array.isArray(input) || input.length > 100) throw new Error("Invalid feedback receipts.");
  const ids = new Set<string>();
  for (const r of input) {
    if (!r || typeof r.id !== "string" || typeof r.state !== "string" || (r.pr !== null && typeof r.pr !== "string") || Object.keys(r).sort().join() !== "id,pr,state" || !/^[BF][A-F0-9]{12}$/.test(r.id) || ids.has(r.id) || !["sent","proposed","needs_info","deferred"].includes(r.state) || r.pr !== null && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(r.pr)) throw new Error("Invalid feedback receipt.");
    if(r.state === "proposed" && !r.pr)throw new Error("A proposed change needs its PR link.");
    ids.add(r.id);
  }
  if (!feedbackEnabled()) return;
  for (const user of getUsers()) {
    const ledger = readLedger(user.id); let changed = false;
    for (const r of ledger.requests) {
      const update = input.find(x => x.id === r.id);
      if (!update || !r.approvedAt || r.state === "withdrawn" || r.state === "preview") continue;
      r.state = update.state; r.pr = update.pr ?? undefined; changed = true;
    }
    if (changed) writeLedger(user.id, ledger);
  }
}
if (process.argv[1]?.endsWith("feedback-export.ts")) {
  try {
    if (process.argv.includes("--receipts")) { let text = ""; for await (const b of process.stdin) { text += b; if (text.length > 30000) throw new Error("Receipt too large"); } applyFeedbackReceipts(JSON.parse(text)); }
    else process.stdout.write(JSON.stringify(approvedFeedback()));
  } catch { process.stderr.write("Feedback handoff failed; raw data withheld.\n"); process.exitCode = 1; }
}
