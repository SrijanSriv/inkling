/** Bound downloads as well as inference, so recordings cannot fill Pi RAM. */
export class VoiceInputError extends Error {
  constructor(public readonly kind: "busy" | "too_long" | "unclear" | "unavailable") { super(kind); }
}
const pending: (() => Promise<void>)[] = [];
const counts = new Map<string, number>();
const arrivals = new Map<string, number[]>();
let active = false;

export function queueVoice<T>(actor: string, work: () => Promise<T>): Promise<T> {
  const now = Date.now();
  for (const [key, times] of arrivals) if (!times.some(t => now - t < 600_000)) arrivals.delete(key);
  const times = (arrivals.get(actor) || []).filter(t => now - t < 600_000);
  if (pending.length >= 8 || (counts.get(actor) || 0) >= 2 || times.length >= 12) {
    return Promise.reject(new VoiceInputError("busy"));
  }
  arrivals.set(actor, [...times, now]);
  counts.set(actor, (counts.get(actor) || 0) + 1);
  return new Promise<T>((resolve, reject) => {
    pending.push(async () => {
      try {
        if (Date.now() - now > 120_000) throw new VoiceInputError("busy");
        resolve(await work());
      } catch (error) { reject(error); }
      finally {
        const remaining = (counts.get(actor) || 1) - 1;
        if (remaining) counts.set(actor, remaining); else counts.delete(actor);
      }
    });
    void drain();
  });
}
async function drain(): Promise<void> {
  if (active) return;
  active = true;
  try { while (pending.length) await pending.shift()!(); }
  finally { active = false; }
}
export const voiceErrorText = (kind: VoiceInputError["kind"]): string => ({
  busy: "I'm busy listening to other recordings. Please send that again shortly, or type it.",
  too_long: "That recording is too long or large. Please send a shorter voice note.",
  unclear: "I couldn't make out that recording reliably. Could you repeat it or type it?",
  unavailable: "I couldn't reach the transcription service. Please try again shortly, or type your message.",
})[kind];
