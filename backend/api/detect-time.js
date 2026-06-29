import { callClaude } from "../lib/anthropic.js";
import { buildDetectTimePrompts } from "../lib/detect-time-prompts.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { text, messageText, viewerLocalDate, viewerTimeZone } = req.body || {};
    const selectionText = String(text || "");
    const fullMessageText =
      typeof messageText === "string" && messageText.trim() ? messageText.trim() : selectionText;

    const { system, user } = buildDetectTimePrompts({
      selectionText,
      messageText: fullMessageText,
      viewerLocalDate:
        typeof viewerLocalDate === "string" && viewerLocalDate.trim()
          ? viewerLocalDate.trim()
          : "unknown",
      viewerTimeZone:
        typeof viewerTimeZone === "string" && viewerTimeZone.trim()
          ? viewerTimeZone.trim()
          : "unknown",
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
