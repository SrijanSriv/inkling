import { config, type User } from "./config.js";
import { googleConnectEnabled } from "./google.js";
import { feedbackEnabled } from "./reliability-store.js";
export function commandHelp(user: User, group = false): string {
  const lines = [group ? `Mention ${config.name} or reply to one of my messages. /bug and /feature also work directly.` : "Text naturally, or use these commands:",
    "/help: this command guide", "/memory: saved notes for this chat", "/reset: fresh conversation, keeping saved notes"];
  if (feedbackEnabled()) lines.push("/bug <description>: report a problem", "/feature <description>: suggest an improvement", "You can also reply to a message with /bug or /feature. I send a private preview; nothing goes to Codex until you approve that exact wording.", "/feedback: your request list and status (private reply)", "/feedback issues: private technical candidates; never exported", "/feedback withdraw <ID>: stop future sharing", "/feedback on or off: enable or mute feature suggestion prompts");
  if (!group) {
    lines.push("/mic: open the voice page, choose the Pi or device microphone, hold to speak, and hear/read the reply", "/google: your connected Google accounts", "/disconnect google [email]: revoke a connection");
    if (googleConnectEnabled()) lines.push("/connect google: connect an account privately");
    if (config.shoppingProvider || config.zeptoEnabled) lines.push("In the household group: /shopping or /shopping basket: checkout status or basket (also /zepto, /instamart)");
    if (user.admin) lines.push("/people: registered people", "/add <name> <number> or /remove <name>: manage access", "/waitlist (or /waiting list): review people waiting", "/link whatsapp or /unlink whatsapp: your personal WhatsApp connection", "In a group: /open or /close: change who may talk to me");
    if (user.owner) lines.push("Room mic controls: /mic speech on|off|status; /mic flow current|early|status; /mic switch on|off");
  } else if (user.admin) lines.push("/open or /close: who may talk to me in this group");
  return lines.join("\n");
}
