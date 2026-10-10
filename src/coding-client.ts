import { config } from "./config.js";

export const codingEnabled = () => !!config.codingUrl && !!config.codingSecret;
export async function codingRequest(input: Record<string, unknown>, artifact = false): Promise<unknown> {
  if (!codingEnabled()) throw new Error("Coding isn't configured.");
  let response: Response;
  try {
    response = await fetch(`${config.codingUrl}/jobs`, {
      method: "POST", headers: { Authorization: `Bearer ${config.codingSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify(input), signal: AbortSignal.timeout(12_000), redirect: "error",
    });
  } catch { throw new Error("The coding laptop is unreachable. Submission may have been accepted; check status before repeating it."); }
  if (artifact && response.ok) {
    if (!response.headers.get("content-type")?.startsWith("application/gzip")) throw new Error("The worker did not return a source archive.");
    if (Number(response.headers.get("content-length") || 0) > 16 * 1024 * 1024) throw new Error("Source archive exceeds delivery limit.");
    const chunks: Uint8Array[] = []; let size = 0;
    if (!response.body) throw new Error("Missing source archive.");
    for await (const chunk of response.body) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error("Source archive exceeds delivery limit."); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  const raw = await response.text();
  if (raw.length > 512 * 1024) throw new Error("Coding response exceeds limit.");
  const data = JSON.parse(raw) as { ok?: boolean; result?: unknown; error?: string };
  if (!response.ok || data.ok !== true) throw new Error(data.error || "Coding request failed.");
  return data.result;
}
