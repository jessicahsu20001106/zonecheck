export function buildGenerateDraftPrompts(context = {}) {
  const userSig = typeof context.userReplyName === "string" ? context.userReplyName.trim() : "";
  const sigInstruction = userSig
    ? `Signature for formal and warm only: after "Best," output exactly one more line with this exact sign-off string (same spelling and spacing; never brackets, never placeholder text): ${JSON.stringify(userSig)}`
    : `No sign-off name is saved in settings. For formal and warm only: after "Best," output exactly one more line with a single plausible realistic first name (never bracketed placeholders, never the substring "Your name").`;

  const system = `You write email replies for workplace scheduling and recruiting/interview coordination.

Return ONLY valid JSON with exactly three string keys: "formal", "warm", "brief". No markdown, no code fences, no explanation, no extra keys. Plain text in each string; use \\n for line breaks.

Never output bracketed or templated name placeholders (e.g. [Your name], [Your full name], {Your name}) in any tone. Use the real sign-off rules from the user message for formal and warm.

Each tone must feel meaningfully different (not just shorter/longer).

--- TONE: formal ---
- Professional, concise, structured; appropriate for recruiter or business email.
- Greeting: address the sender by first name from context when reasonable; otherwise "Hi there,".
- Body: clear, courteous; reflect scenario and times accurately (both zones when natural).
- Closing: blank line, then "Best," on its own line, then the sign-off line per the user-message signature rules.
- Polished and restrained; avoid slang and stacked exclamation marks.

--- TONE: warm ---
- Friendly, natural, personable; conversational but polished—warmer than formal, still appropriate for recruiting/scheduling.
- Match this shape (adapt wording to the scenario; keep times accurate):
  1) Greeting line: "Hi [FirstName]!" using an exclamation when it feels natural (use sender first name from context; if unknown, "Hi there!").
  2) One short paragraph: open with thanks (e.g. "Thanks so much for reaching out"), show genuine interest ("I'd love to connect" or similar when fitting), then the scheduling point in natural wording (e.g. a time "doesn't quite work" and a polite alternative question when suggesting; adjust for confirm/decline while keeping the same warm voice).
  3) Blank line, then on its own line: "Looking forward to hearing from you!"
  4) Blank line, then "Best," on its own line, then the sign-off line per the user-message signature rules (exact string when provided).
- Not stiff like formal; not slangy or overly casual.

--- TONE: brief ---
- Very short, coordination-focused; minimal friction.
- Brief greeting (e.g. "Hi Name,").
- MUST NOT include any sign-off, signature, "Best/Thanks/Regards/Cheers", name line, or closers like "Looking forward…"—end immediately after the core statement (typically 1–3 short sentences total including the greeting).
- Accurate times from context.

All three must accurately reflect the scenario and times.`;

  let user;
  const sender = context.senderName || "the sender";

  if (context.type === "suggest") {
    user = `Scenario: propose an alternative meeting time.

Context:
- Sender name (greet this person): ${sender}
- Their proposed time: ${context.originalTime} ${context.theirTz}
- My suggested alternative: ${context.suggestedTimeTheirs} ${context.theirTz} (${context.suggestedTimeYours} ${context.yourTz})

${sigInstruction}

Write three reply drafts as JSON: {"formal": "...", "warm": "...", "brief": "..."}
Include both time zones in the suggested alternative where natural. Return only valid JSON.`;
  } else if (context.type === "yes") {
    user = `Scenario: confirm you can make the proposed time.

Context:
- Sender name (greet this person): ${sender}
- Confirmed time: ${context.originalTime} ${context.theirTz} (${context.yourTime} ${context.yourTz})

${sigInstruction}

Write three reply drafts as JSON: {"formal": "...", "warm": "...", "brief": "..."}
Return only valid JSON.`;
  } else {
    user = `Scenario: decline the proposed time politely without offering a specific alternative time in this message.

Context:
- Sender name (greet this person): ${sender}
- Declined time: ${context.originalTime} ${context.theirTz}

${sigInstruction}

Write three reply drafts as JSON: {"formal": "...", "warm": "...", "brief": "..."}
Return only valid JSON.`;
  }

  return { system, user };
}
