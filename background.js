// Service worker — routes AI requests to the Zonecheck Vercel backend

const ZONECHECK_SW_VERSION = "1.0.5-production";
const ZONECHECK_API_BASE = "https://zonecheck-api.vercel.app";

console.info("[Zonecheck] service worker loaded", {
  version: ZONECHECK_SW_VERSION,
  apiBase: ZONECHECK_API_BASE,
});

async function postToBackend(path, body) {
  const url = `${ZONECHECK_API_BASE}${path}`;
  console.info("[Zonecheck] calling backend", { endpoint: path, url });

  let response;
  try {
    response = await self.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[Zonecheck] backend network error", {
      endpoint: path,
      url,
      error: err?.message || String(err),
    });
    throw new Error(`Could not reach Zonecheck backend (${url}).`);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    console.error("[Zonecheck] backend request failed", {
      endpoint: path,
      url,
      status: response.status,
      error: data.error || `HTTP ${response.status}`,
    });
    throw new Error(data.error || `API error ${response.status}`);
  }

  console.info("[Zonecheck] backend request succeeded", {
    endpoint: path,
    url,
    status: response.status,
  });
  return data;
}

function coerceNum(n, fallback) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

/** 12-hour clock + AM/PM token → 24-hour { hour, minute }. */
function to24HourFrom12(h12, minute, ampmRaw) {
  const amp = String(ampmRaw || "")
    .replace(/\./g, "")
    .trim()
    .toUpperCase();
  const isPm = amp.startsWith("P");
  let h = Number(h12);
  if (!Number.isFinite(h) || h < 1 || h > 12) h = 12;
  const m = Math.min(59, Math.max(0, coerceNum(minute, 0)));
  if (isPm) {
    if (h !== 12) h += 12;
  } else if (h === 12) {
    h = 0;
  }
  return { hour: h % 24, minute: m };
}

/** "after 2 PM", "no earlier than 3:30 PM", "not before 9 AM" */
function parseAfterTimeConstraint(original) {
  const o = String(original || "");
  const patterns = [
    /\bafter\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i,
    /\bno\s+earlier\s+than\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i,
    /\bnot\s+before\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i,
  ];
  for (const re of patterns) {
    const m = o.match(re);
    if (m) {
      const h12 = parseInt(m[1], 10);
      const mm = m[2] ? parseInt(m[2], 10) : 0;
      return to24HourFrom12(h12, mm, m[3]);
    }
  }
  return null;
}

/** "morning … before 11 AM" → default morning start, capped to stay before the ceiling. */
function parseBeforeMorningTimeConstraint(original) {
  const o = String(original || "");
  if (!/\bmorning\b/i.test(o)) return null;
  const m = o.match(/\bbefore\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (!m) return null;
  const ceil = to24HourFrom12(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0, m[3]);
  const ceilTotal = ceil.hour * 60 + ceil.minute;
  const morningDefault = 9 * 60;
  const pick = Math.min(morningDefault, ceilTotal - 60);
  if (pick < 0) return { hour: 0, minute: 0 };
  return { hour: Math.floor(pick / 60), minute: pick % 60 };
}

/** "before 5 PM" without "morning" — prefer model time if under ceiling, else one hour before ceiling. */
function parseBeforeNonMorningTimeConstraint(original, modelHour, modelMinute) {
  const o = String(original || "");
  if (/\bmorning\b/i.test(o)) return null;
  const m = o.match(/\bbefore\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (!m) return null;
  const ceil = to24HourFrom12(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0, m[3]);
  const ceilTotal = ceil.hour * 60 + ceil.minute;
  const modelTotal = modelHour * 60 + modelMinute;
  const pick = Math.min(modelTotal, ceilTotal - 60);
  if (pick < 0) return { hour: 0, minute: 0 };
  return { hour: Math.floor(pick / 60), minute: pick % 60 };
}

/** "at 2 PM", "at 2:30 PM" */
function parseAtTimeConstraint(original) {
  const o = String(original || "");
  const m = o.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (!m) return null;
  return to24HourFrom12(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0, m[3]);
}

/** Last 12h clock in the phrase (e.g. "afternoon … 2 PM" without "after"). */
function parseLastStandalone12hClock(original) {
  const o = String(original || "");
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/gi;
  let last = null;
  let m;
  while ((m = re.exec(o)) !== null) {
    last = to24HourFrom12(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0, m[3]);
  }
  return last;
}

/** When the phrase implies part of day but no explicit clock, snap to app defaults. */
function snapPartOfDayFromPhrase(original, hour, minute) {
  const o = String(original || "").toLowerCase();
  if (/\bnoon\b/.test(o)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(o)) return { hour: 0, minute: 0 };
  if (/\bafternoon\b/.test(o)) return { hour: 13, minute: 0 };
  if (/\bmorning\b/.test(o)) return { hour: 9, minute: 0 };
  if (/\bevening\b/.test(o) || /\btonight\b/.test(o)) return { hour: 18, minute: 0 };
  const hasPart = /\b(afternoon|morning|noon|evening|night|midnight)\b/.test(o);
  const looksDateOnly =
    !hasPart &&
    (/\b(tomorrow|today)\b/.test(o) ||
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(o) ||
      /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(o));
  if (looksDateOnly) return { hour: 9, minute: 0 };
  return { hour, minute };
}

/**
 * Priority: explicit time constraints in text → fuzzy part-of-day defaults → model clock.
 * (Model still supplies date/timezone; this fixes default hour/minute when the phrase mixes fuzzy + explicit.)
 */
function resolveDefaultClockFromOriginal(original, modelHour, modelMinute) {
  const o = String(original || "");
  let t = parseAfterTimeConstraint(o);
  if (t) return t;
  t = parseBeforeMorningTimeConstraint(o);
  if (t) return t;
  t = parseBeforeNonMorningTimeConstraint(o, modelHour, modelMinute);
  if (t) return t;
  t = parseAtTimeConstraint(o);
  if (t) return t;
  const fuzzy = snapPartOfDayFromPhrase(o, modelHour, modelMinute);
  const hasPartOfDay = /\b(afternoon|morning|noon|evening|night|midnight)\b/i.test(o);
  const lastClock = parseLastStandalone12hClock(o);
  if (lastClock && hasPartOfDay) return lastClock;
  if (/\d{1,2}\s*(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)\b/i.test(o) || /\b\d{1,2}:\d{2}\b/.test(o)) {
    return { hour: modelHour, minute: modelMinute };
  }
  return fuzzy;
}

const WEEKDAY_TO_DOW = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Same abbreviations as content.js TZ_MAP (subset used for email inference). */
const TZ_ABBR_TO_IANA = {
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  PT: "America/Los_Angeles",
  MST: "America/Denver",
  MDT: "America/Denver",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  EST: "America/New_York",
  EDT: "America/New_York",
  ET: "America/New_York",
  GMT: "Europe/London",
  UTC: "UTC",
  BST: "Europe/London",
  CET: "Europe/Paris",
  CEST: "Europe/Paris",
  EET: "Europe/Helsinki",
  IST: "Asia/Kolkata",
  JST: "Asia/Tokyo",
  KST: "Asia/Seoul",
  AEST: "Australia/Sydney",
  AEDT: "Australia/Sydney",
  NZST: "Pacific/Auckland",
  NZDT: "Pacific/Auckland",
  HST: "Pacific/Honolulu",
  AKST: "America/Anchorage",
  AKDT: "America/Anchorage",
};

/** City / country / region → display label + IANA (checked before generic abbr scan). */
const LOCATION_TZ_RULES = [
  { re: /\bTokyo\b/i, label: "JST", iana: "Asia/Tokyo" },
  { re: /\bOsaka\b/i, label: "JST", iana: "Asia/Tokyo" },
  { re: /\bKyoto\b/i, label: "JST", iana: "Asia/Tokyo" },
  { re: /\bJapan\b/i, label: "JST", iana: "Asia/Tokyo" },
  { re: /\bSeoul\b/i, label: "KST", iana: "Asia/Seoul" },
  { re: /\bKorea\b/i, label: "KST", iana: "Asia/Seoul" },
  { re: /\bLondon\b/i, label: "GMT", iana: "Europe/London" },
  { re: /\bParis\b/i, label: "CET", iana: "Europe/Paris" },
  { re: /\bBerlin\b/i, label: "CET", iana: "Europe/Paris" },
  { re: /\bSydney\b/i, label: "AEST", iana: "Australia/Sydney" },
  { re: /\bMelbourne\b/i, label: "AEST", iana: "Australia/Sydney" },
  { re: /\bAuckland\b/i, label: "NZST", iana: "Pacific/Auckland" },
  { re: /\bHonolulu\b/i, label: "HST", iana: "Pacific/Honolulu" },
  { re: /\bLos Angeles\b/i, label: "PT", iana: "America/Los_Angeles" },
  { re: /\bSan Francisco\b/i, label: "PT", iana: "America/Los_Angeles" },
  { re: /\bNew York\b/i, label: "ET", iana: "America/New_York" },
  { re: /\bChicago\b/i, label: "CT", iana: "America/Chicago" },
  { re: /\bDenver\b/i, label: "MT", iana: "America/Denver" },
  { re: /\bMumbai\b/i, label: "IST", iana: "Asia/Kolkata" },
  { re: /\bIndia\b/i, label: "IST", iana: "Asia/Kolkata" },
];

const EMAIL_TZ_ABBR_RE =
  /\b(EST|EDT|ET|PST|PDT|PT|CST|CDT|MST|MDT|AKST|AKDT|HST|GMT|UTC|BST|CET|CEST|IST|JST|KST|AEST|AEDT|NZST|NZDT|EET)\b/g;

function parseYmdToLocalDate(ymd) {
  const [y, mo, d] = ymd.split("-").map(Number);
  return new Date(y, mo - 1, d);
}

function formatLocalYmd(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

function addCalendarDaysYmd(ymd, deltaDays) {
  const dt = parseYmdToLocalDate(ymd);
  dt.setDate(dt.getDate() + deltaDays);
  return formatLocalYmd(dt);
}

function isWeekdayAfterNextPhrase(text) {
  return (
    /\b(?:the\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+after\s+next\b/i.test(
      text
    ) ||
    /\bafter\s+next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text)
  );
}

/**
 * Closest upcoming weekday from anchor; "next Tuesday" does NOT skip an extra week.
 * "the Tuesday after next" → +7 days beyond the first upcoming occurrence.
 */
function resolveRelativeWeekdayDate(original, anchorYmd) {
  const o = String(original || "");
  const m = o.match(/\b(next|this)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (!m) return null;

  const modifier = (m[1] || "").toLowerCase();
  const dayName = m[2].toLowerCase();
  const targetDow = WEEKDAY_TO_DOW[dayName];
  if (targetDow == null) return null;

  const anchor = parseYmdToLocalDate(anchorYmd);
  const anchorDow = anchor.getDay();
  let daysAhead = (targetDow - anchorDow + 7) % 7;
  const afterNext = isWeekdayAfterNextPhrase(o);

  if (afterNext) {
    if (daysAhead === 0) daysAhead = 7;
    daysAhead += 7;
    return addCalendarDaysYmd(anchorYmd, daysAhead);
  }

  if (modifier === "next") {
    if (daysAhead === 0) daysAhead = 7;
    return addCalendarDaysYmd(anchorYmd, daysAhead);
  }

  if (modifier === "this") {
    if (daysAhead === 0) return anchorYmd;
    return addCalendarDaysYmd(anchorYmd, daysAhead);
  }

  if (daysAhead === 0) daysAhead = 7;
  return addCalendarDaysYmd(anchorYmd, daysAhead);
}

function resolveRelativeDateFromPhrase(original, anchorYmd) {
  const o = String(original || "");
  if (/\btomorrow\b/i.test(o)) return addCalendarDaysYmd(anchorYmd, 1);
  if (/\btoday\b/i.test(o)) return anchorYmd;
  return resolveRelativeWeekdayDate(original, anchorYmd);
}

function inferExplicitTimezoneFromEmail(emailText) {
  const text = String(emailText || "");
  if (!text.trim()) return null;

  const parenAbbr = text.match(
    /\(\s*(JST|KST|IST|GMT|UTC|BST|CET|CEST|EST|EDT|ET|PST|PDT|PT|CST|CDT|MST|MDT|AEST|AEDT|NZST|NZDT|HST|AKST|AKDT|EET)\s*\)/i
  );
  if (parenAbbr) {
    const abbr = parenAbbr[1].toUpperCase();
    const iana = TZ_ABBR_TO_IANA[abbr];
    if (iana) return { label: abbr, iana };
  }

  for (const rule of LOCATION_TZ_RULES) {
    if (rule.re.test(text)) return { label: rule.label, iana: rule.iana };
  }

  const offset = text.match(/\b(?:GMT|UTC)\s*([+-])\s*(\d{1,2})(?:\s*:\s*(\d{2}))?\b/i);
  if (offset) {
    const sign = offset[1] === "-" ? -1 : 1;
    const hours = parseInt(offset[2], 10);
    const signed = sign * hours;
    if (signed === 9) return { label: "JST", iana: "Asia/Tokyo" };
    if (signed === 8) return { label: "CST", iana: "Asia/Shanghai" };
    if (signed === 5) return { label: "IST", iana: "Asia/Kolkata" };
    if (signed === 0) return { label: "GMT", iana: "UTC" };
    if (signed === 1) return { label: "CET", iana: "Europe/Paris" };
    if (signed === 10) return { label: "AEST", iana: "Australia/Sydney" };
    if (signed === -5) return { label: "EST", iana: "America/New_York" };
    if (signed === -8) return { label: "PT", iana: "America/Los_Angeles" };
  }

  EMAIL_TZ_ABBR_RE.lastIndex = 0;
  let abbrMatch;
  while ((abbrMatch = EMAIL_TZ_ABBR_RE.exec(text)) !== null) {
    const abbr = abbrMatch[1].toUpperCase();
    const iana = TZ_ABBR_TO_IANA[abbr];
    if (iana) return { label: abbr, iana };
  }

  return null;
}

function normalizeTimeEntry(t, emailContext, viewerLocalDate) {
  if (!t || typeof t !== "object") return null;
  const original = typeof t.original === "string" ? t.original.trim() : "";
  if (!original) return null;
  let date = typeof t.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : null;
  if (!date) return null;

  if (viewerLocalDate && /^\d{4}-\d{2}-\d{2}$/.test(viewerLocalDate)) {
    const resolved = resolveRelativeDateFromPhrase(original, viewerLocalDate);
    if (resolved) date = resolved;
  }

  let hour = Math.min(23, Math.max(0, coerceNum(t.hour, 9)));
  let minute = Math.min(59, Math.max(0, coerceNum(t.minute, 0)));
  const snapped = resolveDefaultClockFromOriginal(original, hour, minute);
  hour = snapped.hour;
  minute = snapped.minute;

  let timezone =
    typeof t.timezone === "string" && t.timezone.trim() ? t.timezone.trim() : null;
  const explicitTz = inferExplicitTimezoneFromEmail(emailContext);
  if (explicitTz) timezone = explicitTz.label;

  return {
    original,
    hour,
    minute,
    date,
    timezone,
    ambiguous: Boolean(t.ambiguous),
  };
}

function normalizeDetectResponse(parsed, emailContext, viewerLocalDate) {
  const senderName = typeof parsed.senderName === "string" ? parsed.senderName : "";
  const rawTimes = Array.isArray(parsed.times) ? parsed.times : [];
  const times = rawTimes
    .map((t) => normalizeTimeEntry(t, emailContext, viewerLocalDate))
    .filter(Boolean);
  return { senderName, times };
}

async function detectTime(emailText, viewerContext = {}) {
  const selectionText = String(emailText || "");
  const messageText =
    typeof viewerContext.messageText === "string" && viewerContext.messageText.trim()
      ? viewerContext.messageText.trim()
      : selectionText;
  const emailContext = `${selectionText}\n${messageText}`.trim();

  const viewerLocalDate =
    typeof viewerContext.viewerLocalDate === "string" && viewerContext.viewerLocalDate.trim()
      ? viewerContext.viewerLocalDate.trim()
      : "unknown";
  const viewerTimeZone =
    typeof viewerContext.viewerTimeZone === "string" && viewerContext.viewerTimeZone.trim()
      ? viewerContext.viewerTimeZone.trim()
      : "unknown";

  const { raw } = await postToBackend("/api/detect-time", {
    text: selectionText,
    messageText,
    viewerLocalDate,
    viewerTimeZone,
  });
  const jsonMatch = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("No time references found in selected text.");
  const parsed = JSON.parse(jsonMatch[0]);
  if (Array.isArray(parsed)) {
    return normalizeDetectResponse({ senderName: "", times: parsed }, emailContext, viewerLocalDate);
  }
  return normalizeDetectResponse(parsed, emailContext, viewerLocalDate);
}

const PLACEHOLDER_NAME_PATTERNS = [
  /\[Your full name\]/gi,
  /\[Your name\]/gi,
  /\{Your full name\}/gi,
  /\{Your name\}/gi,
];

function normalizeDrafts(parsed) {
  return {
    formal: typeof parsed.formal === "string" ? parsed.formal : "",
    warm: typeof parsed.warm === "string" ? parsed.warm : "",
    brief: typeof parsed.brief === "string" ? parsed.brief : "",
  };
}

function sanitizeDraftPlaceholders(drafts, userReplyName) {
  const base = normalizeDrafts(drafts);
  const safe = (userReplyName || "").trim();
  const out = { ...base };
  for (const key of ["formal", "warm", "brief"]) {
    let t = out[key];
    if (safe) {
      for (const p of PLACEHOLDER_NAME_PATTERNS) t = t.replace(p, safe);
    } else {
      for (const p of PLACEHOLDER_NAME_PATTERNS) t = t.replace(p, "");
      t = t.replace(/\n{3,}/g, "\n\n");
    }
    out[key] = t.replace(/\n\s*\n\s*$/m, "\n").trimEnd();
  }
  return out;
}

async function generateReplyDraft(context) {
  const userSig = typeof context.userReplyName === "string" ? context.userReplyName.trim() : "";

  const { raw } = await postToBackend("/api/generate-draft", { context });
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to generate reply draft.");
  const parsed = JSON.parse(jsonMatch[0]);
  return sanitizeDraftPlaceholders(parsed, userSig);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "DETECT_TIME") {
    console.info("[Zonecheck] DETECT_TIME → POST /api/detect-time");
    detectTime(message.text, {
      viewerLocalDate: message.viewerLocalDate,
      viewerTimeZone: message.viewerTimeZone,
      messageText: message.messageText,
    })
      .then(({ senderName, times }) => {
        console.info("[Zonecheck] DETECT_TIME succeeded", { timeCount: times?.length ?? 0 });
        sendResponse({ success: true, senderName, times });
      })
      .catch((err) => {
        console.error("[Zonecheck] DETECT_TIME failed", { error: err.message });
        sendResponse({ success: false, error: err.message });
      });
    return true; // keep channel open for async
  }

  if (message.type === "GENERATE_DRAFT") {
    console.info("[Zonecheck] GENERATE_DRAFT → POST /api/generate-draft", {
      draftType: message.context?.type,
    });
    generateReplyDraft(message.context)
      .then((drafts) => {
        console.info("[Zonecheck] GENERATE_DRAFT succeeded");
        sendResponse({ success: true, drafts });
      })
      .catch((err) => {
        console.error("[Zonecheck] GENERATE_DRAFT failed", { error: err.message });
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
});
