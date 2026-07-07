import { callClaude } from "../lib/anthropic.js";
import { buildGenerateDraftPrompts } from "../lib/generate-draft-prompts.js";
import { applyRateLimitHeaders, checkRateLimit } from "../lib/rate-limit.js";
import { rejectIfBodyTooLarge, validateGenerateDraftBody } from "../lib/validate.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const bodyTooLarge = rejectIfBodyTooLarge(req);
  if (bodyTooLarge) {
    return res.status(bodyTooLarge.status).json({ success: false, error: bodyTooLarge.error });
  }

  const rate = await checkRateLimit(req);
  if (!rate.allowed) {
    applyRateLimitHeaders(res, rate);
    return res.status(rate.status).json({ success: false, error: rate.error });
  }

  const validated = validateGenerateDraftBody(req.body);
  if (!validated.ok) {
    return res.status(validated.status).json({ success: false, error: validated.error });
  }

  try {
    const { context } = validated.data;
    const { system, user } = buildGenerateDraftPrompts(context);
    const raw = await callClaude(system, user);
    return res.status(200).json({ success: true, raw });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to generate draft",
    });
  }
}
