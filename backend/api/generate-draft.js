import { callClaude } from "../lib/anthropic.js";
import { buildGenerateDraftPrompts } from "../lib/generate-draft-prompts.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const context = req.body?.context ?? req.body ?? {};
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
