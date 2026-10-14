import type { ToolResult } from './tool-replies.js';

/** Shopping facts come from the adapter, never a model's reconstruction of old chat. */
export function shoppingReplyNeedsEvidence(text: string): boolean {
  return /\b(?:instamart|zepto|gpay|google\s*pay|upi|checkout|cart|basket|payment\s+(?:request|pending|link)|(?:order\s+(?:place[ds]?|confirmed|ho)|(?:placed|confirmed)\s+(?:the\s+)?order)|free\s+delivery|delivery\s+(?:charge|fee|bill))\b/i.test(text);
}

export function shoppingResultReply(results: ToolResult[]): string | undefined {
  const shopping = results.filter(r => r.name.startsWith('household_'));
  if (!shopping.length) return undefined;
  // Keep the latest basket snapshot instead of repeating stale intermediate quantities.
  const lastBasket = shopping.findLastIndex(r => /^household_basket_(?:show|update)$/.test(r.name));
  return [...new Set(shopping.filter((r,i) => !/^household_basket_(?:show|update)$/.test(r.name) || i === lastBasket)
    .map(r => r.output.trim()).filter(Boolean))].join('\n\n') || undefined;
}
