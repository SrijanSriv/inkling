// Local producer only. It never starts a WhatsApp connection or sends a message itself.
import { enqueueOperation } from "./operations.js";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 16_000) throw new Error("Operations notice too large.");
}
const notice = JSON.parse(input) as { key: string; message: string };
enqueueOperation(notice.key, notice.message);
