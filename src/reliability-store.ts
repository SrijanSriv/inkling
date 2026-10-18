import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { log } from "./log.js";

export const ISSUE_CODES = ["tool_failed", "unsupported_claim", "protocol_reply", "reply_failed", "link_delivery_failed", "article_failed", "article_uncertain", "scheduled_failed", "scheduled_skipped", "interrupted"] as const;
export type IssueCode = typeof ISSUE_CODES[number];
export type Request = { id: string; kind: "bug" | "feature"; description: string; state: "preview" | "approved" | "sent" | "withdrawn" | "proposed" | "needs_info" | "deferred"; at: number; approvedAt?: number; previewId: string; pr?: string };
export type Ledger = { prompts: boolean; lastOffer: number; issues: { code: IssueCode; count: number; first: number; latest: number }[]; requests: Request[]; seen: string[] };
const empty = (): Ledger => ({ prompts: true, lastOffer: 0, issues: [], requests: [], seen: [] });
export const feedbackEnabled = () => !!config.reliabilityDir && !!config.reliabilityKeyFile;
function settings() {
  if (!feedbackEnabled()) throw new Error("Feedback is not configured yet.");
  const root = path.resolve(config.reliabilityDir!);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root || (statSync(root).mode & 0o077)) throw new Error("Feedback storage permissions are unsafe.");
  const sourceRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."));
  if(root===sourceRoot||root.startsWith(sourceRoot+path.sep)||sourceRoot.startsWith(root+path.sep))throw new Error("Feedback storage must be outside source archives.");
  const data = realpathSync(config.dataDir);
  if (root === data || root.startsWith(data + path.sep) || data.startsWith(root + path.sep)) throw new Error("Feedback storage must be outside the backup data root.");
  const keyFile = path.resolve(config.reliabilityKeyFile!);
  if (realpathSync(keyFile) !== keyFile || (statSync(keyFile).mode & 0o077) || keyFile === data || keyFile.startsWith(data + path.sep) || keyFile.startsWith(root + path.sep) || keyFile.startsWith(sourceRoot + path.sep)) throw new Error("Feedback key must be protected and separate from data and feedback storage.");
  const key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error("Invalid feedback key.");
  return { root, key };
}
export function readLedger(scope: string): Ledger {
  const { root, key } = settings();
  const file = path.join(root, createHmac("sha256", key).update(scope).digest("hex") + ".sealed");
  if (!existsSync(file)) return empty();
  if (statSync(file).size > 256_000) throw new Error("Feedback store exceeds its bound.");
  const [version, iv, tag, body] = readFileSync(file, "utf8").split(".");
  if (version !== "v1") throw new Error("Invalid feedback envelope.");
  const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  cipher.setAAD(Buffer.from(scope)); cipher.setAuthTag(Buffer.from(tag, "base64"));
  const ledger = JSON.parse(Buffer.concat([cipher.update(Buffer.from(body, "base64")), cipher.final()]).toString()) as Ledger;
  const before = JSON.stringify(ledger);
  const cutoff = Date.now() - 90 * 86400000;
  ledger.issues = ledger.issues.filter(i => i.latest > Date.now() - 30 * 86400000).slice(-ISSUE_CODES.length);
  ledger.requests = ledger.requests.filter(r => r.at > cutoff && (r.state !== "preview" || Date.now()-r.at < 30*60000)).slice(-100);
  if(JSON.stringify(ledger)!==before)writeLedger(scope,ledger);
  return ledger;
}
export function writeLedger(scope: string, ledger: Ledger): void {
  const { root, key } = settings(), iv = randomBytes(12);
  const file = path.join(root, createHmac("sha256", key).update(scope).digest("hex") + ".sealed");
  const text = JSON.stringify(ledger);
  if (text.length > 200_000 || ledger.requests.length > 100 || ledger.issues.length > ISSUE_CODES.length) throw new Error("Feedback store is full.");
  const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(scope));
  const body = Buffer.concat([cipher.update(text), cipher.final()]);
  writeFileSync(file + ".tmp", ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join("."), { mode: 0o600 });
  renameSync(file + ".tmp", file);
}
/** Code-owned enums only. No text, tool arguments, URLs, recordings or error strings. Never exported. */
export function recordIssue(scope: string, code: IssueCode): void {
  if (!feedbackEnabled() || !ISSUE_CODES.includes(code)) return;
  try {
    const ledger = readLedger(scope), now = Date.now(), old = ledger.issues.find(i => i.code === code);
    if (old) { old.count = Math.min(10000, old.count + 1); old.latest = now; }
    else ledger.issues.push({ code, count: 1, first: now, latest: now });
    writeLedger(scope, ledger);
  } catch { log.warn("private reliability recording unavailable"); }
}

/** Expire inactive encrypted files too. No decrypting archives or exporting identities. */
export function startReliabilityRetention(): void {
  if(!feedbackEnabled())return;
  const clean=()=>{try{const {root}=settings();for(const name of readdirSync(root)){if(/^[a-f0-9]{64}\.sealed$/.test(name)&&Date.now()-statSync(path.join(root,name)).mtimeMs>90*86400000)rmSync(path.join(root,name));}}catch{log.warn("private reliability retention unavailable");}};
  clean();setInterval(clean,3600000).unref();
}
