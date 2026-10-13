import { z } from "zod";
import { config } from "./config.js";
import { VoiceInputError } from "./voice-intake.js";

const Result = z.object({ text: z.string().trim().min(1).max(16000), warning: z.string().max(200).optional() });

/** Uses the existing authenticated tunnel, with a separately configured warm microphone decoder. */
export async function transcribeMicrophone(audio: Buffer, signal: AbortSignal): Promise<{ text: string; warning?: string }> {
  if (!config.whisperUrl || !config.whisperSecret) throw new VoiceInputError("unavailable");
  try {
    const response = await fetch(new URL("/microphone", config.whisperUrl), {
      method: "POST", headers: { authorization: `Bearer ${config.whisperSecret}`, "content-type": "application/octet-stream" },
      body: new Uint8Array(audio), signal: AbortSignal.any([signal, AbortSignal.timeout(190_000)]),
    });
    if (!response.ok) throw new VoiceInputError(response.status === 422 ? "unclear" : response.status === 429 ? "busy" : response.status === 413 ? "too_long" : "unavailable");
    const raw = await response.text();
    if (raw.length > 64000) throw new VoiceInputError("unclear");
    return Result.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof VoiceInputError) throw error;
    throw new VoiceInputError("unavailable");
  }
}
