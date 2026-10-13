type Candidate = { model: string; text?: string; error?: string; warning?: string };
export type MicrophoneReview = { text: string; clarification?: string };

const reminder = /remind|reminder|yaad|याद/iu;
const negative = /\b(?:don't|dont|not|never|mat|nahi)\b|मत|नहीं/iu;
const timing = /\d|minute|minit|minut|hour|baje|tomorrow|morning|after|before|baad|subah|kal|मिन|घंट|बज|बाद|सुबह|कल/iu;

/** Disagreement is a warning, never a vote or a calibrated confidence score. */
export function reviewMicrophone(results: Candidate[], primary: string, reference: string): MicrophoneReview {
  const chosen = results.find(r => r.model === primary);
  const other = results.find(r => r.model === reference);
  if (!chosen?.text?.trim() || chosen.error) throw new Error("No usable primary microphone transcript");
  const text = chosen.text.trim();
  const issues: string[] = [];
  if (chosen.warning) issues.push("The recognizer may have skipped part of the recording. Please check Listen back and repeat the missing part.");
  if (!other?.text?.trim() || other.error || other.warning) {
    issues.push("The second recognizer could not reliably check this recording. Please check the whole transcript.");
  } else {
    if (reminder.test(text) !== reminder.test(other.text)) issues.push("The recognizers disagree about whether you asked for a reminder. Please clarify that in text.");
    if (negative.test(text) !== negative.test(other.text)) issues.push("The recognizers disagree about a 'don't' or 'not'. Please clarify what you want in text.");
  }
  // Both decoders can agree and still mishear a number. Time-bearing requests always need typed clarification.
  if (reminder.test(text) || timing.test(text) || (other?.text && (reminder.test(other.text) || timing.test(other.text)))) {
    issues.push("If this is a reminder or timed request, please type the intended delay or date and time. I won't infer it from this recording.");
  }
  return { text, clarification: issues.length ? issues.join("\n") : undefined };
}
