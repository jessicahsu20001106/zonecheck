import { callClaude } from "../lib/anthropic.js";
import { buildDetectTimePrompts } from "../lib/detect-time-prompts.js";
import { applyRateLimitHeaders, checkRateLimit } from "../lib/rate-limit.js";
import { rejectIfBodyTooLarge, validateDetectTimeBody } from "../lib/validate.js";

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

  const validated = validateDetectTimeBody(req.body);
  if (!validated.ok) {
    return res.status(validated.status).json({ success: false, error: validated.error });
  }

  try {
    const { selectionText, messageText, viewerLocalDate, viewerTimeZone } = validated.data;

    const { system, user } = buildDetectTimePrompts({
      selectionText,
      messageText,
      viewerLocalDate,
      viewerTimeZone,
    });

    const raw = await callClaude(system, user);
    return res.status(200).json({ success: true, raw });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to detect time",
    });
  }
}
