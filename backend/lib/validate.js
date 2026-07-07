/** Max JSON body size (Content-Length), in bytes. */
export const MAX_BODY_BYTES = 65536;

/** Caps applied before text is sent to Claude (truncate, do not reject). */
export const MAX_SELECTION_TEXT = 2000;
export const MAX_MESSAGE_TEXT = 50000;
export const MAX_CONTEXT_STRING = 500;
export const MAX_USER_REPLY_NAME = 100;
export const MAX_TIMEZONE_STRING = 120;
export const MAX_DATE_STRING = 32;

const DRAFT_TYPES = new Set(["yes", "no", "suggest"]);

function capString(value, maxLen) {
  if (typeof value !== "string") return "";
  return value.slice(0, maxLen);
}

function trimCap(value, maxLen) {
  return capString(value, maxLen).trim();
}

function invalid(status, error) {
  return { ok: false, status, error };
}

function valid(data) {
  return { ok: true, data };
}

/** Reject oversized request bodies via Content-Length header. */
export function rejectIfBodyTooLarge(req) {
  const raw = req.headers["content-length"];
  if (raw == null || raw === "") return null;
  const bytes = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(bytes)) return null;
  if (bytes > MAX_BODY_BYTES) {
    return {
      status: 413,
      error: "Request is too large. Please select a smaller portion of the email.",
    };
  }
  return null;
}

export function validateDetectTimeBody(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return invalid(400, "Invalid request body.");
  }

  if (typeof body.text !== "string") {
    return invalid(400, "Missing required field: text.");
  }

  const selectionText = trimCap(body.text, MAX_SELECTION_TEXT);
  if (!selectionText) {
    return invalid(400, "Selected text cannot be empty.");
  }

  let messageText = selectionText;
  if (body.messageText != null) {
    if (typeof body.messageText !== "string") {
      return invalid(400, "Invalid field: messageText must be a string.");
    }
    const trimmed = trimCap(body.messageText, MAX_MESSAGE_TEXT);
    if (trimmed) messageText = trimmed;
  }

  let viewerLocalDate = "unknown";
  if (body.viewerLocalDate != null) {
    if (typeof body.viewerLocalDate !== "string") {
      return invalid(400, "Invalid field: viewerLocalDate must be a string.");
    }
    const trimmed = trimCap(body.viewerLocalDate, MAX_DATE_STRING);
    if (trimmed) viewerLocalDate = trimmed;
  }

  let viewerTimeZone = "unknown";
  if (body.viewerTimeZone != null) {
    if (typeof body.viewerTimeZone !== "string") {
      return invalid(400, "Invalid field: viewerTimeZone must be a string.");
    }
    const trimmed = trimCap(body.viewerTimeZone, MAX_TIMEZONE_STRING);
    if (trimmed) viewerTimeZone = trimmed;
  }

  return valid({ selectionText, messageText, viewerLocalDate, viewerTimeZone });
}

export function validateGenerateDraftBody(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return invalid(400, "Invalid request body.");
  }

  const rawContext = body.context ?? body;
  if (rawContext == null || typeof rawContext !== "object" || Array.isArray(rawContext)) {
    return invalid(400, "Missing required field: context.");
  }

  if (typeof rawContext.type !== "string" || !DRAFT_TYPES.has(rawContext.type)) {
    return invalid(400, "Invalid or missing field: context.type (yes, no, or suggest).");
  }

  const context = {
    type: rawContext.type,
    senderName: trimCap(rawContext.senderName ?? "the sender", MAX_CONTEXT_STRING) || "the sender",
    userReplyName: trimCap(rawContext.userReplyName ?? "", MAX_USER_REPLY_NAME),
    originalTime: trimCap(rawContext.originalTime ?? "", MAX_CONTEXT_STRING),
    theirTz: trimCap(rawContext.theirTz ?? "", MAX_TIMEZONE_STRING),
    yourTime: trimCap(rawContext.yourTime ?? "", MAX_CONTEXT_STRING),
    yourTz: trimCap(rawContext.yourTz ?? "", MAX_TIMEZONE_STRING),
    suggestedTimeTheirs: trimCap(rawContext.suggestedTimeTheirs ?? "", MAX_CONTEXT_STRING),
    suggestedTimeYours: trimCap(rawContext.suggestedTimeYours ?? "", MAX_CONTEXT_STRING),
  };

  if (!context.originalTime) {
    return invalid(400, "Missing required field: context.originalTime.");
  }

  if (context.type === "suggest") {
    if (!context.suggestedTimeTheirs || !context.suggestedTimeYours) {
      return invalid(400, "Missing suggested times for a suggest draft.");
    }
  } else if (context.type === "yes" && !context.yourTime) {
    return invalid(400, "Missing required field: context.yourTime for a confirmation draft.");
  }

  return valid({ context });
}
