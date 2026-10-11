import { chatFile } from "./store.js";
import { readSealedJson, writeSealedJson } from "./vault.js";
import { codingRequest, CodingRejected } from "./coding-client.js";

type Pending = { id: string; request: Record<string, unknown>; at: number; cancelling?: boolean };
const file = (owner: string) => chatFile(owner, "coding-outbox.json");
const load = (owner: string) => readSealedJson<Pending[]>(file(owner), []);
const save = (owner: string, entries: Pending[]) => writeSealedJson(file(owner), entries);
const target = (request: Record<string, unknown>) => String(request.job || request.project || "").toLowerCase();
const TTL = 7 * 24 * 3_600_000;
type Transport = (request: Record<string, unknown>) => Promise<unknown>;

export function pendingCoding(owner: string): unknown[] {
  return load(owner).map(p => ({ id: p.id, job: p.request.job, project: p.request.project, at: p.at, expired: Date.now() - p.at > TTL, cancelling: !!p.cancelling, prompt: typeof p.request.prompt === "string" ? p.request.prompt.slice(0, 1000) : "" }));
}

export async function submitContinuation(owner: string, request: Record<string, unknown>, send: Transport = codingRequest): Promise<unknown> {
  if (!target(request) || typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 12_000) throw new Error("Specify an existing coding project/job and a brief continuation.");
  const pending = load(owner);
  const old = pending.find(p => target(p.request) === target(request));
  if (old) return { pending: old.id, message: "A continuation is already saved on the Pi for this target. Inspect coding_pending, then resume or cancel it; do not replace it silently." };
  if (pending.length >= 10) throw new Error("There are ten unresolved coding requests. Resume or cancel one first.");
  const entry: Pending = { id: String(request.requestId), request: { ...request, owner, action: "continue" }, at: Date.now() };
  save(owner, [...pending, entry]);
  return deliver(owner, entry, send, false);
}

async function deliver(owner: string, entry: Pending, send: Transport, reconcile: boolean): Promise<unknown> {
  try {
    // Receipt lookup is authoritative. A status listing cannot prove non-acceptance.
    const receipt = reconcile ? await send({ action: "receipt", owner, requestId: entry.id }) : null;
    const result = receipt ?? await send(entry.request);
    if (!result || typeof result !== "object" || !("id" in result) || !/^C[0-9]+$/.test(String(result.id)) || !("revision" in result) || !Number.isSafeInteger(result.revision) || !("state" in result) || typeof result.state !== "string") throw new Error("Invalid worker acknowledgement.");
    save(owner, load(owner).filter(p => p.id !== entry.id));
    return result;
  } catch (err) {
    if (err instanceof CodingRejected) {
      // During reconciliation even a rejected lookup may mean an old worker lacks the endpoint.
      if (!reconcile) save(owner, load(owner).filter(p => p.id !== entry.id));
      throw err;
    }
    return { pending: entry.id, message: "Saved on the Pi. Worker acceptance is unknown because the laptop could not be reached reliably. It will not retry automatically. Ask to resume or cancel the saved request." };
  }
}

export async function resumeCoding(owner: string, id: string, cancel = false, send: Transport = codingRequest): Promise<unknown> {
  const entry = load(owner).find(p => p.id === id);
  if (!entry) throw new Error("Pending request not found. Use coding_pending.");
  if (cancel) {
    entry.cancelling = true;
    save(owner, load(owner).map(p => p.id === id ? entry : p));
    // Mark intent before network access, so a failed cancellation can never be resumed later.
    try {
      // Worker withdrawal is atomic with receipt creation: a late original request cannot run.
      const result = await send({ action: "withdraw", owner, requestId: entry.id });
      if (!result || typeof result !== "object" || !("withdrawn" in result) || result.withdrawn !== true) throw new Error("Withdrawal not acknowledged.");
      save(owner, load(owner).filter(p => p.id !== id));
      return { cancelledPending: true, result, message: "The saved submission was withdrawn. Describe the actual worker result: earlier completed work is not undone and later revisions are not automatically stopped." };
    } catch {
      return { pending: id, cancelling: true, message: "Cancellation is saved on the Pi, so this request cannot resume. Worker cancellation is not yet confirmed. Ask to cancel it again once the laptop is reachable." };
    }
  }
  if (entry.cancelling) throw new Error("Cancellation is pending. Reconcile cancellation instead of resuming.");
  if (Date.now() - entry.at > TTL) throw new Error("This saved request expired. Cancel/reconcile it, then give a fresh instruction.");
  return deliver(owner, entry, send, true);
}
