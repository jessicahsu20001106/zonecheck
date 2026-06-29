export function buildDetectTimePrompts({
  selectionText = "",
  messageText = "",
  viewerLocalDate = "unknown",
  viewerTimeZone = "unknown",
}) {
  const system =
    "You extract scheduling time references and the sender from email text. Return only valid JSON, no explanation or markdown.";

  const user = `Extract time references and the sender from this email text.

The reader's local calendar date (for "today", "tomorrow", "next Monday", "this week", etc.) is: ${viewerLocalDate}.
The reader's IANA timezone (hint when the email does not name a zone) is: ${viewerTimeZone}.

Return JSON only in this shape:
{
  "senderName": "sender display or first name, or empty string if unknown",
  "times": [
    {
      "original": "exact phrase from the email",
      "hour": 14,
      "minute": 0,
      "timezone": "PST or America/Los_Angeles; null only if unknown",
      "date": "2026-01-16",
      "ambiguous": false
    }
  ]
}

Rules:
- Support natural language and vague recruiter phrasing (e.g. "next Monday afternoon", "tomorrow", "Monday morning", "next Friday at noon"). Always resolve to ONE concrete calendar date and clock time in 24-hour local time for that date (minute 0 unless a specific minute is stated).
- Parsing priority for the default clock when the phrase mixes relative/fuzzy wording with times in the text:
  1) Explicit date + explicit clock + timezone from the phrase (use those).
  2) Relative/fuzzy date + explicit time constraint phrases — these OVERRIDE generic part-of-day defaults: "after 2 PM", "no earlier than 3 PM", "not before 9 AM" → use that clock as the chosen time; "before 11 AM" with "morning" → use 9:00 or the latest sensible morning slot before that ceiling (e.g. before 11 AM with morning → 9:00); "before X" without "morning" → stay at or under one hour before X, preferring the model time if already valid.
  3) "at 2 PM" / "at 2:30 PM" → use that clock.
  4) Part of day with no numeric constraint: morning = 9:00, afternoon = 13:00, noon = 12:00, evening = 18:00. If only a date/day is given with no part of day and no clock (e.g. "tomorrow", "next Tuesday"), use 9:00.
  5) If the phrase names a part of day but also states a standalone clock without "after"/"before"/"at" (e.g. "Monday afternoon 2 PM"), prefer that stated clock over the part-of-day default.
- If the email states an explicit time, use that time; do not replace it with defaults.
- Infer a reasonable near-future date when needed. Use the reader's local date above for relative phrases.
- Relative weekdays: "next Tuesday" means the closest upcoming Tuesday within the next 7 days (do NOT add an extra week). Only skip to the following week for phrases like "the Tuesday after next" or "Tuesday after next".
- For "timezone", use the same abbreviation or wording as in the email when it names one (e.g. EST, EDT, PST, PT, JST, GMT+9). Do not substitute a different daylight or standard label than the email used. Use null only when the email gives no clue.
- If the email states the sender is in a city or zone (e.g. Tokyo, JST, Japan), the "timezone" field MUST reflect that — never infer the reader's local zone instead.
- If the selected text names a timezone (e.g. "EST", "PST", "EDT", "PDT", "ET", "PT", "JST"), the "timezone" field MUST be that exact token.

Selected text:
${selectionText}

Full email message (for sender timezone / location context):
${messageText}`;

  return { system, user };
}
