// Content script — Gmail DOM interaction, highlights, and popover UI

(function () {
  "use strict";

  const ZT = globalThis.ZC_TIMEZONE;
  if (!ZT) {
    throw new Error(
      "[Zonecheck] ZC_TIMEZONE missing — add tz-picker-shared.js before content.js in manifest.json"
    );
  }

  const { buildTimezoneSelectHtml, syncTimezoneSelects, bindTimezoneSelects: bindTimezoneSelectsShared, closeTzPicker } =
    ZT;

  function bindTimezoneSelects(el) {
    bindTimezoneSelectsShared(el, (_wrap, which, newTz, root) => {
      applyScheduleTimezoneChange(getActiveScheduleState(), which, newTz);
      refreshActiveScheduleStep(root);
    });
  }

  // ─── Runtime guard ───────────────────────────────────────────────────────

  function sendToBackground(message, callback) {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      callback({
        success: false,
        error: "Zonecheck was reloaded — please refresh this Gmail tab to reconnect.",
      });
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          callback({
            success: false,
            error: "Zonecheck was reloaded — please refresh this Gmail tab to reconnect.",
          });
          return;
        }
        callback(response);
      });
    } catch {
      callback({
        success: false,
        error: "Zonecheck was reloaded — please refresh this Gmail tab to reconnect.",
      });
    }
  }

  let lastDetectMessageContext = "";

  // ─── State ────────────────────────────────────────────────────────────────

  let activePopover = null;
  let activePill = null;
  let activeRange = null;
  let selectionAnchorRect = null;
  let detectedTimes = [];
  let userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let businessHours = { start: 9, end: 18 };
  let draftData = null;
  let theirDisplayName = "Sender";

  // Global drag state — lives outside initDrag to avoid listener accumulation
  let dragState = null; // { dragging, trackEl }
  let popoverDragState = null; // { popover, pointerId, offsetX, offsetY }
  let popoverViewportPosition = null; // { top, left }

  chrome.storage.local.get(
    ["user_timezone", "business_hours", "user_reply_name"],
    (result) => {
      if (result.user_timezone) userTimezone = result.user_timezone;
      if (result.business_hours) businessHours = result.business_hours;
    }
  );

  // ─── Global drag listeners (registered once) ─────────────────────────────
  // FIX: Previously initDrag() added new document mousemove/mouseup listeners
  // every time refreshStep2 was called, causing listeners to accumulate and
  // conflict with each other. Now we register them once globally.

  function clearStep2DragActiveClasses(root) {
    if (!root) return;
    root.querySelectorAll(".zc-marker-dragging").forEach((node) => {
      node.classList.remove("zc-marker-dragging");
    });
    root.querySelectorAll(".zc-timeline-dragging").forEach((node) => {
      node.classList.remove("zc-timeline-dragging");
    });
  }

  function handleStep2DragMove(e) {
    if (!dragState?.dragging) return;
    if (dragState.pointerId != null && e.pointerId != null && e.pointerId !== dragState.pointerId) {
      return;
    }
    applyStep2DragFromPointer(e.clientX);
  }

  function endStep2Drag(e) {
    if (!dragState) return;
    if (dragState.pointerId != null && e?.pointerId != null && e.pointerId !== dragState.pointerId) {
      return;
    }
    const pop = activePopover;
    clearStep2DragActiveClasses(pop);
    dragState = null;
    if (pop) refreshActiveScheduleStep(pop);
  }

  function handlePopoverDragMove(e) {
    if (!popoverDragState) return;
    if (popoverDragState.pointerId != null && e.pointerId != null && e.pointerId !== popoverDragState.pointerId) {
      return;
    }
    const { popover, offsetX, offsetY } = popoverDragState;
    if (!popover.isConnected) {
      popoverDragState = null;
      return;
    }
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    const left = Math.min(Math.max(e.clientX - offsetX, margin), maxLeft);
    const top = Math.min(Math.max(e.clientY - offsetY, margin), maxTop);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popoverViewportPosition = { top, left };
  }

  function endPopoverDrag(e) {
    if (!popoverDragState) return;
    if (popoverDragState.pointerId != null && e?.pointerId != null && e.pointerId !== popoverDragState.pointerId) {
      return;
    }
    popoverDragState.popover?.classList.remove("zc-popover-dragging");
    popoverDragState = null;
  }

  function isPopoverDragInteractiveTarget(target) {
    return Boolean(
      target.closest(
        "button, a, input, select, textarea, label, [role='button'], [contenteditable='true']"
      )
    );
  }

  function bindPopoverDrag(popover) {
    if (!popover || popover.dataset.zcDragBound === "1") return;
    const header = popover.querySelector(".zc-header");
    if (!header) return;
    popover.dataset.zcDragBound = "1";

    const beginPopoverDrag = (e) => {
      if (e.button != null && e.button !== 0) return;
      if (!header.contains(e.target) || isPopoverDragInteractiveTarget(e.target)) return;
      const rect = popover.getBoundingClientRect();
      popoverDragState = {
        popover,
        pointerId: e.pointerId ?? null,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
      };
      popover.classList.add("zc-popover-dragging");
      e.preventDefault();
      if (typeof header.setPointerCapture === "function" && e.pointerId != null) {
        try {
          header.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    };

    if (window.PointerEvent) {
      header.addEventListener("pointerdown", beginPopoverDrag);
    } else {
      header.addEventListener("mousedown", beginPopoverDrag);
    }
  }

  document.addEventListener("pointermove", handlePopoverDragMove);
  document.addEventListener("mousemove", handlePopoverDragMove);
  document.addEventListener("pointerup", endPopoverDrag);
  document.addEventListener("pointercancel", endPopoverDrag);
  document.addEventListener("mouseup", endPopoverDrag);

  document.addEventListener("pointermove", handleStep2DragMove);
  document.addEventListener("mousemove", handleStep2DragMove);
  document.addEventListener("pointerup", endStep2Drag);
  document.addEventListener("pointercancel", endStep2Drag);
  document.addEventListener("mouseup", endStep2Drag);

  // ─── Utility ──────────────────────────────────────────────────────────────

  /** Abbreviation for an IANA zone at a calendar date (DST-aware). Omit dateYmd to use "now". */
  function tzAbbr(tz, dateYmd) {
    try {
      let instant;
      if (dateYmd && tz && tz.includes("/")) {
        instant = new Date(utcMsFromWallClockInTimeZone(dateYmd, 12, 0, tz));
      } else {
        instant = new Date();
      }
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        timeZoneName: "short",
      }).formatToParts(instant);
      return parts.find((p) => p.type === "timeZoneName")?.value || tz;
    } catch {
      return tz;
    }
  }

  /** Raw token from detection (e.g. EST, PDT) — not an IANA id like America/New_York */
  function extractEmailTimezoneLabel(timezoneRaw) {
    if (timezoneRaw == null) return null;
    const s = String(timezoneRaw).trim();
    if (!s || s.includes("/")) return null;
    return s;
  }

  /** Abbreviations matched in selection / email text (longer tokens first where relevant). */
  const SELECTION_TZ_ABBR_RE =
    /\b(EST|EDT|ET|PST|PDT|PT|CST|CDT|MST|MDT|AKST|AKDT|HST|GMT|UTC|BST|CET|CEST|IST|JST|AEST|AEDT|NZST|NZDT|EET)\b/i;

  function extractTimezoneAbbrFromText(text) {
    const m = String(text || "").match(SELECTION_TZ_ABBR_RE);
    return m ? m[1].toUpperCase() : null;
  }

  /** Map a known abbreviation or IANA id to IANA; null if unknown (no viewer fallback). */
  function mapAbbrToIana(abbr) {
    if (!abbr) return null;
    const s = String(abbr).trim();
    if (!s) return null;
    if (s.includes("/")) return s;
    return TZ_MAP[s.toUpperCase()] || null;
  }

  const SENDER_LOCATION_IANA = [
    [/\bTokyo\b/i, "Asia/Tokyo"],
    [/\bJapan\b/i, "Asia/Tokyo"],
    [/\bOsaka\b/i, "Asia/Tokyo"],
    [/\bSeoul\b/i, "Asia/Seoul"],
    [/\bLondon\b/i, "Europe/London"],
    [/\bParis\b/i, "Europe/Paris"],
    [/\bSydney\b/i, "Australia/Sydney"],
    [/\bHonolulu\b/i, "Pacific/Honolulu"],
    [/\bLos Angeles\b/i, "America/Los_Angeles"],
    [/\bNew York\b/i, "America/New_York"],
    [/\bChicago\b/i, "America/Chicago"],
    [/\bMumbai\b/i, "Asia/Kolkata"],
    [/\bIndia\b/i, "Asia/Kolkata"],
  ];

  /** Sender zone: explicit location/abbr in message or selection > API token > viewer default. */
  function resolveTheirIanaFromDetection(timeObj, messageContext = "") {
    const corpus = `${timeObj?.original || ""}\n${messageContext || ""}`.trim();
    const fromCorpus = extractTimezoneAbbrFromText(corpus);
    if (fromCorpus) {
      const m = mapAbbrToIana(fromCorpus);
      if (m) return m;
    }
    for (const [re, iana] of SENDER_LOCATION_IANA) {
      if (re.test(corpus)) return iana;
    }
    const raw = typeof timeObj?.timezone === "string" ? timeObj.timezone.trim() : "";
    if (raw) {
      const m = mapAbbrToIana(raw.includes("/") ? raw : raw.toUpperCase());
      if (m) return m;
    }
    return userTimezone;
  }

  /** Prefer email wording when it maps to the same IANA zone; else Intl short name at date. */
  function theirTzUiLabel(ianaTz, dateYmd, { persistedEmailLabel, rawTimeObjTimezone } = {}) {
    if (persistedEmailLabel) return persistedEmailLabel;
    const email = extractEmailTimezoneLabel(rawTimeObjTimezone);
    if (email && mapAbbrToIana(email) === ianaTz) return email;
    return tzAbbr(ianaTz, dateYmd);
  }


  function formatHour(h, m = 0) {
    const ampm = h < 12 ? "am" : "pm";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const mStr = m > 0 ? `:${String(m).padStart(2, "0")}` : "";
    return `${h12}${mStr}${ampm}`;
  }

  // Format time for Step 2 large display: "2:00 PM" style
  /** e.g. 9:00 AM — for hero + banners */
  function formatHourClock12(h, m = 0) {
    const ampm = h < 12 ? "AM" : "PM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const mm = String(m).padStart(2, "0");
    return `${h12}:${mm} ${ampm}`;
  }

  function viewerLocalDateYmdInTz(ianaTz) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: ianaTz || userTimezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      const y = parts.find((p) => p.type === "year")?.value;
      const mo = parts.find((p) => p.type === "month")?.value;
      const d = parts.find((p) => p.type === "day")?.value;
      if (y && mo && d) return `${y}-${mo}-${d}`;
    } catch {
      /* ignore */
    }
    return new Date().toISOString().slice(0, 10);
  }

  /** Step 2 hero input: 4pm, 4:30 PM, 16:00, etc. */
  function parseTimeInput(raw) {
    if (raw == null) return null;
    const s = String(raw).trim().replace(/\s+/g, " ");
    if (!s) return null;

    let m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
    }

    m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)$/i);
    if (m) {
      let hour = parseInt(m[1], 10);
      const minute = m[2] ? parseInt(m[2], 10) : 0;
      const mer = m[3].replace(/\./g, "").toLowerCase();
      if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
      if (hour === 12) hour = mer === "am" ? 0 : 12;
      else if (mer === "pm") hour += 12;
      return { hour, minute };
    }

    return null;
  }

  function formatDate(dateStr, tz) {
    try {
      const d = new Date(dateStr + "T12:00:00Z");
      return d.toLocaleDateString("en-US", {
        timeZone: tz,
        weekday: "short",
        month: "short",
        day: "numeric",
      });
    } catch {
      return dateStr;
    }
  }

  function utcMsFromWallClockInTimeZone(dateYmd, hour, minute, timeZone) {
    const [y, m, d] = dateYmd.split("-").map(Number);
    const desired = Date.UTC(y, m - 1, d, hour, minute, 0);
    let utcMs = desired;
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });

    for (let i = 0; i < 3; i++) {
      const parts = formatter.formatToParts(new Date(utcMs));
      const get = (type) => parts.find((p) => p.type === type)?.value;
      const asUtc = Date.UTC(
        Number(get("year")),
        Number(get("month")) - 1,
        Number(get("day")),
        Number(get("hour")),
        Number(get("minute")),
        Number(get("second") || 0)
      );
      const diff = desired - asUtc;
      if (diff === 0) break;
      utcMs += diff;
    }

    return utcMs;
  }

  /** Wall clock in a zone for an absolute instant (DST-aware). */
  function wallClockPartsFromUtcMs(utcMs, timeZone) {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
      const parts = formatter.formatToParts(new Date(utcMs));
      const get = (type) => parts.find((p) => p.type === type)?.value;
      return {
        date: `${get("year")}-${get("month")}-${get("day")}`,
        hour: parseInt(get("hour"), 10) % 24,
        minute: parseInt(get("minute"), 10),
        second: parseInt(get("second"), 10) || 0,
      };
    } catch {
      return { date: "", hour: 0, minute: 0, second: 0 };
    }
  }

  /** Next calendar day for an ISO `YYYY-MM-DD` string (Gregorian). */
  function ymdAddCalendarDays(ymd, deltaDays) {
    const [y, mo, d] = ymd.split("-").map(Number);
    const jd = new Date(Date.UTC(y, mo - 1, d + deltaDays));
    const yy = jd.getUTCFullYear();
    const mm = String(jd.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(jd.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  function convertTime(timeObj, targetTz) {
    try {
      const sourceTz = resolveIanaTz(timeObj.timezone);
      const utcMs = utcMsFromWallClockInTimeZone(
        timeObj.date,
        timeObj.hour,
        timeObj.minute || 0,
        sourceTz
      );
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: targetTz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      const parts = formatter.formatToParts(new Date(utcMs));
      const get = (type) => parts.find((p) => p.type === type)?.value;
      return {
        hour: parseInt(get("hour"), 10) % 24,
        minute: parseInt(get("minute"), 10),
        date: `${get("year")}-${get("month")}-${get("day")}`,
      };
    } catch {
      return { hour: timeObj.hour, minute: timeObj.minute || 0, date: timeObj.date };
    }
  }

  /** Step 2 rail: 24 equal hour bands; snap pointer to whole hour 0–23. */
  function snapRailPctToNearestHour(pct) {
    const clamped = Math.max(0, Math.min(100, pct));
    const hourIdx = Math.floor((clamped / 100) * 24);
    return hourIdx >= 24 ? 23 : hourIdx;
  }

  function getStep2DragTrack() {
    if (!activePopover || !dragState) return null;
    const cached = dragState.trackEl;
    if (cached?.isConnected) return cached;
    const { trackTz, trackDate } = dragState;
    if (!trackTz || !trackDate) return null;
    for (const track of activePopover.querySelectorAll(".zc-timeline-interactive")) {
      if (track.dataset.tz === trackTz && track.dataset.date === trackDate) {
        dragState.trackEl = track;
        return track;
      }
    }
    return null;
  }

  function pickStep2DragMarkerId(track, snappedHour) {
    const markers = [...track.querySelectorAll(".zc-marker-drag")];
    if (markers.length === 0) return null;
    if (markers.length === 1) return markers[0].dataset.id;
    const targetPct = hourToPercent(snappedHour);
    let best = markers[0];
    let bestDist = Infinity;
    for (const m of markers) {
      const pos = parseFloat(m.style.left);
      const dist = Number.isFinite(pos) ? Math.abs(pos - targetPct) : Infinity;
      if (dist < bestDist) {
        bestDist = dist;
        best = m;
      }
    }
    return best.dataset.id;
  }

  function applyStep2DragFromPointer(clientX, trackOverride) {
    const track = trackOverride || getStep2DragTrack();
    if (!track || !dragState?.dragging) return;
    dragState.trackEl = track;
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    let pct = ((clientX - rect.left) / rect.width) * 100;
    pct = Math.max(0, Math.min(100, pct));
    const snappedHour = snapRailPctToNearestHour(pct);

    const s = getActiveScheduleState();
    const splitBefore = timelinesSplitOnDifferentDays(s.theirDate, s.yourDate);
    if (dragState.dragging === "their") {
      s.theirHour = snappedHour;
      s.theirMinute = 0;
      const y = convertTimeWholeHours(
        { timezone: s.theirTz, hour: s.theirHour, minute: 0, date: s.theirDate },
        s.yourTz
      );
      s.yourHour = y.hour;
      s.yourMinute = 0;
      s.yourDate = y.date;
    } else {
      s.yourHour = snappedHour;
      s.yourMinute = 0;
      const t = convertTimeWholeHours(
        { timezone: s.yourTz, hour: s.yourHour, minute: 0, date: s.yourDate },
        s.theirTz
      );
      s.theirHour = t.hour;
      s.theirMinute = 0;
      s.theirDate = t.date;
    }

    const splitAfter = timelinesSplitOnDifferentDays(s.theirDate, s.yourDate);
    if (activePopover) {
      refreshActiveScheduleStep(activePopover, { skipTimelineRebuild: dragState && splitBefore === splitAfter });
    }
  }

  function addDaysYMD(ymd, deltaDays) {
    const [y, mo, d] = ymd.split("-").map(Number);
    const u = Date.UTC(y, mo - 1, d + deltaDays);
    const dt = new Date(u);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  /** Nearest wall-clock hour on a calendar day (minute always 0); date shifts if rounding crosses midnight. */
  function roundWallTimeToWholeHourOnDate(hour, minute, dateStr) {
    const absMin = hour * 60 + minute;
    const roundedMin = Math.round(absMin / 60) * 60;
    const dayOffset = Math.floor(roundedMin / (24 * 60));
    const within = ((roundedMin % (24 * 60)) + 24 * 60) % (24 * 60);
    return {
      hour: within / 60,
      minute: 0,
      date: addDaysYMD(dateStr, dayOffset),
    };
  }

  /** After TZ conversion, force whole-hour clock in the target zone (linked markers stay hour-aligned). */
  function convertTimeWholeHours(timeObj, targetTz) {
    const c = convertTime(timeObj, targetTz);
    return roundWallTimeToWholeHourOnDate(c.hour, c.minute, c.date);
  }

  function isInBusinessHours(hour) {
    return hour >= businessHours.start && hour < businessHours.end;
  }

  function businessHoursStatus(theirHour, yourHour) {
    const theirOk = isInBusinessHours(theirHour);
    const yourOk = isInBusinessHours(yourHour);
    if (theirOk && yourOk) return "green";
    if (!theirOk && !yourOk) return "red";
    return "amber";
  }

  function scheduleOutsideHoursIconHtml() {
    return `<span class="zc-schedule-hint-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  }

  function noTimeDetectedIconHtml() {
    return `<span class="zc-schedule-hint-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="2"/><path d="M12 8v4l2.5 1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  }

  function theirBusinessHoursPhrase(theirName) {
    const name = normalizeSenderName(theirName);
    if (!name || name === "Sender") return "their business hours";
    return `${name}'s business hours`;
  }

  /** Gentle caution strip shared by Steps 1 & 2 when someone is outside business hours. */
  function buildOutsideHoursBannerHtml(t) {
    if (businessHoursStatus(t.theirHour, t.yourHour) === "green") return "";
    const yourOk = isInBusinessHours(t.yourHour);
    const theirOk = isInBusinessHours(t.theirHour);
    const theirTime = `${formatHourClock12(t.theirHour, t.theirMinute)} ${theirTzUiLabel(t.theirTz, t.theirDate, {
      persistedEmailLabel: t.theirTzEmailLabel,
      rawTimeObjTimezone: t.rawTimeObjTimezone,
    })}`;
    const yourTime = `${formatHourClock12(t.yourHour, t.yourMinute)} ${tzAbbr(t.yourTz, t.yourDate)}`;

    let message;
    if (!theirOk && !yourOk) {
      message = `${theirTime} and ${yourTime} are outside both of your business hours`;
    } else if (!theirOk) {
      message = `${theirTime} is outside ${theirBusinessHoursPhrase(t.theirName)}`;
    } else {
      message = `${yourTime} is outside your business hours`;
    }

    return `<div class="zc-schedule-hint zc-schedule-hint-outside" role="status">${scheduleOutsideHoursIconHtml()}<span class="zc-schedule-hint-text">${escHtml(message)}</span></div>`;
  }

  function buildStep2HoursNoticeHtml(s) {
    return buildOutsideHoursBannerHtml({
      theirHour: s.theirHour,
      theirMinute: s.theirMinute,
      theirTz: s.theirTz,
      theirTzEmailLabel: s.theirTzEmailLabel,
      rawTimeObjTimezone: s.timeObj?.timezone,
      theirDate: s.theirDate,
      yourHour: s.yourHour,
      yourMinute: s.yourMinute,
      yourTz: s.yourTz,
      yourDate: s.yourDate,
      theirName: normalizeSenderName(s?.theirName) || theirNameLabel(),
    });
  }

  /**
   * UTC half-open range [start, end) for configured business hours on one local calendar day.
   * `businessHours.end` is exclusive (e.g. 18 ⇒ wall times up to but not including 6:00 PM).
   */
  function utcRangeBusinessHoursOnDate(dateYmd, timeZone, bh) {
    const start = utcMsFromWallClockInTimeZone(dateYmd, bh.start, 0, timeZone);
    const end = utcMsFromWallClockInTimeZone(dateYmd, bh.end, 0, timeZone);
    return { start, end };
  }

  /** Calendar dates in `tz` that occur at any instant in [windowStartUtc, windowEndExUtc). */
  function calendarDatesSpanningUtcWindow(windowStartUtc, windowEndExUtc, tz) {
    try {
      if (!(windowEndExUtc > windowStartUtc)) return [];
      const d0 = wallClockPartsFromUtcMs(windowStartUtc, tz).date;
      const d1 = wallClockPartsFromUtcMs(windowEndExUtc - 1, tz).date;
      if (!d0 || !d1) return [];
      const lo = d0 <= d1 ? d0 : d1;
      const hi = d0 <= d1 ? d1 : d0;
      const out = [];
      let cur = lo;
      for (;;) {
        out.push(cur);
        if (cur === hi) break;
        cur = ymdAddCalendarDays(cur, 1);
      }
      return out;
    } catch {
      return [];
    }
  }

  function mergeAndLongestUtcOverlap(pieces) {
    if (!pieces.length) return null;
    pieces.sort((a, b) => a.overlapStartUtc - b.overlapStartUtc);
    const merged = [];
    const MERGE_EPS_MS = 60 * 1000; // treat tiny gaps as continuous for rendering
    for (const iv of pieces) {
      const last = merged[merged.length - 1];
      if (!last || iv.overlapStartUtc > last.overlapEndUtc + MERGE_EPS_MS) {
        merged.push({ overlapStartUtc: iv.overlapStartUtc, overlapEndUtc: iv.overlapEndUtc });
      } else {
        last.overlapEndUtc = Math.max(last.overlapEndUtc, iv.overlapEndUtc);
      }
    }
    // Rendering should cover the entire shared-hours window, not just the longest segment.
    return { overlapStartUtc: merged[0].overlapStartUtc, overlapEndUtc: merged[merged.length - 1].overlapEndUtc };
  }

  /**
   * Coordination window on **user** timeline (not selected meeting time / warnings):
   * left = your business-hours start; right = max(your BH end, sender’s BH end mapped onto your axis).
   * This reads as the full local-time span you can work with (e.g. 9am–6pm yours) even when strict
   * two-sided overlap ends earlier (e.g. sender closed at 3pm your time). Yellow banner still flags
   * a choice outside strict BH.
   */
  function coordinationWindowFracsOnUserAxis(axisDateYmd, theirDateYmd, tzTheir, tzYours, bh) {
    try {
      const dayStart = utcMsFromWallClockInTimeZone(axisDateYmd, 0, 0, tzYours);
      const dayEndEx = utcMsFromWallClockInTimeZone(ymdAddCalendarDays(axisDateYmd, 1), 0, 0, tzYours);
      if (!(dayEndEx > dayStart)) return null;

      const userStartUtc = utcMsFromWallClockInTimeZone(axisDateYmd, bh.start, 0, tzYours);
      const senderEndExUtc = utcMsFromWallClockInTimeZone(theirDateYmd, bh.end, 0, tzTheir);
      const lastInstantInSenderBhUtc = senderEndExUtc - 1;

      let startFrac = fractionalDayHourOnRail(Math.max(userStartUtc, dayStart), axisDateYmd, tzYours);
      if (startFrac == null) startFrac = bh.start;

      let senderEndOnUserAxis = fractionalDayHourOnRail(lastInstantInSenderBhUtc, axisDateYmd, tzYours);
      if (senderEndOnUserAxis == null) {
        const w = wallClockPartsFromUtcMs(lastInstantInSenderBhUtc, tzYours);
        if (w?.date === axisDateYmd) {
          senderEndOnUserAxis = w.hour + w.minute / 60 + (w.second || 0) / 3600;
        }
      }

      const userConfiguredEndFrac = bh.end;
      let endFrac = Math.max(userConfiguredEndFrac, senderEndOnUserAxis ?? -Infinity);
      if (!Number.isFinite(endFrac)) endFrac = userConfiguredEndFrac;

      startFrac = Math.max(0, Math.min(24, startFrac));
      endFrac = Math.min(24, Math.max(startFrac, endFrac));

      if (endFrac <= startFrac) return null;
      return { startFrac, endFrac };
    } catch {
      return null;
    }
  }

  /**
   * Fractional hour-of-day (0–24) in `tz` at `utcMs`, or null if parts are missing.
   */
  function wallClockHourFractionAt(utcMs, tz) {
    try {
      const w = wallClockPartsFromUtcMs(utcMs, tz);
      if (!w.date) return null;
      return w.hour + w.minute / 60 + (w.second || 0) / 3600;
    } catch {
      return null;
    }
  }

  /** True iff `utcMs` falls in configured business hours (half-open [start, end)) in `tz`. */
  function instantInBusinessHoursWallClock(utcMs, tz, bh) {
    const frac = wallClockHourFractionAt(utcMs, tz);
    if (frac == null) return false;
    return frac >= bh.start && frac < bh.end;
  }

  /** Fallback when `railTz` is neither party TZ. */
  function findMutualBhOverlapUtcScan(windowStartUtc, windowEndExUtc, tzTheir, tzYours, bh) {
    try {
      if (!(windowEndExUtc > windowStartUtc)) return null;
      const bothInBh = (utcMs) =>
        instantInBusinessHoursWallClock(utcMs, tzTheir, bh) && instantInBusinessHoursWallClock(utcMs, tzYours, bh);
      const STEP_MS = 60 * 1000;
      const segments = [];
      let curStart = null;
      for (let t = windowStartUtc; t < windowEndExUtc; t += STEP_MS) {
        const ok = bothInBh(t);
        if (ok) {
          if (curStart == null) curStart = t;
        } else if (curStart != null) {
          let s = curStart;
          while (s > windowStartUtc && bothInBh(s - STEP_MS)) s -= STEP_MS;
          while (s > windowStartUtc && bothInBh(s - 1000)) s -= 1000;
          const e = t;
          if (e > s) segments.push({ overlapStartUtc: s, overlapEndUtc: e });
          curStart = null;
        }
      }
      if (curStart != null) {
        let s = curStart;
        while (s > windowStartUtc && bothInBh(s - STEP_MS)) s -= STEP_MS;
        while (s > windowStartUtc && bothInBh(s - 1000)) s -= 1000;
        const e = windowEndExUtc;
        if (e > s) segments.push({ overlapStartUtc: s, overlapEndUtc: e });
      }
      return mergeAndLongestUtcOverlap(segments);
    } catch {
      return null;
    }
  }

  function buildTimelineDragHintHtml() {
    return `<p class="zc-drag-hint"><span class="zc-drag-hint-ico" aria-hidden="true">↔</span> Drag the timeline to find a time that works for both</p>`;
  }

  function buildSourceBadgeHtml(kind) {
    if (kind === "detected") {
      return `<span class="zc-step2-source-pill zc-source-pill-detected">Detected from email</span>`;
    }
    return `<span class="zc-step2-source-pill zc-source-pill-settings">From settings</span>`;
  }


  function normalizeSenderName(name) {
    if (!name) return "";
    let cleaned = String(name).trim();
    cleaned = cleaned.replace(/\s*<[^>]+>\s*$/, "").trim();
    cleaned = cleaned.replace(/^["']|["']$/g, "").trim();
    return cleaned;
  }

  function inferSenderNameFromGmail() {
    const sel = window.getSelection();
    const anchor = sel?.anchorNode;
    if (!anchor) return "";
    const el = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
    if (!el) return "";
    const messageRoot = el.closest(".gs, [data-message-id], .adn");
    if (!messageRoot) return "";
    const senderEl = messageRoot.querySelector(".gD, span.gD[email], .go .gD");
    if (!senderEl) return "";
    const fromAttr = senderEl.getAttribute("name") || senderEl.getAttribute("data-name");
    return normalizeSenderName(fromAttr || senderEl.textContent);
  }

  /** Full message body near the selection — used for sender timezone/location when the highlight is shorter. */
  function getEmailMessageTextNearSelection() {
    const sel = window.getSelection();
    const anchor = sel?.anchorNode;
    if (!anchor) return "";
    const el = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
    if (!el) return "";
    const messageRoot = el.closest(".gs, [data-message-id], .adn");
    if (!messageRoot) return "";
    const body = messageRoot.querySelector(".a3s.aiL, .a3s, .ii.gt, .ii");
    const text = (body?.innerText || body?.textContent || messageRoot.innerText || "").trim();
    return text;
  }

  function resolveTheirDisplayName(aiName) {
    return normalizeSenderName(aiName) || inferSenderNameFromGmail() || "Sender";
  }

  function theirNameLabel() {
    if (activePopover?.classList.contains("zc-popover-step1")) {
      const fromStep1 = normalizeSenderName(step1State?.theirName);
      if (fromStep1) return fromStep1;
    }
    const fromStep2 = normalizeSenderName(step2State?.theirName);
    if (fromStep2) return fromStep2;
    return normalizeSenderName(theirDisplayName) || "Sender";
  }

  function theirNameFieldHtml() {
    return `<input type="text" class="zc-step2-who zc-step2-who-input" id="zc-their-name" value="${escAttr(theirNameLabel())}" aria-label="Sender name" spellcheck="false" autocomplete="off" />`;
  }

  function syncTheirNameFromInput(el) {
    const input = el.querySelector("#zc-their-name");
    if (!input) return;
    theirDisplayName = normalizeSenderName(input.value) || "Sender";
    const s = getActiveScheduleState();
    if (s && typeof s === "object") {
      s.theirName = theirDisplayName;
    }
    updateTheirNameLabels(el);
    updateOutsideHoursNotice(el);
  }

  function updateOutsideHoursNotice(el) {
    const s = getActiveScheduleState();
    if (!s || s.theirHour == null) return;
    const noticeSlot = el.querySelector("#zc-step1-hours-notice, #zc-step2-hours-notice");
    if (noticeSlot) noticeSlot.innerHTML = buildStep2HoursNoticeHtml(s);
  }

  function updateTheirNameLabels(el) {
    const name = theirNameLabel();
    const input = el.querySelector("#zc-their-name");
    if (input && input.value !== name) input.value = name;
    el.querySelectorAll(".zc-legend-their-name").forEach((node) => {
      node.textContent = name;
    });
    const theirDate = step2State?.theirDate;
    const yourDate = step2State?.yourDate;
    const theirTz = step2State?.theirTz;
    if (theirDate && yourDate && theirDate !== yourDate && theirTz) {
      const label = el.querySelector(".zc-timeline-day-their .zc-timeline-day-label");
      if (label) label.textContent = `${name} · ${formatDate(theirDate, theirTz)}`;
    }
  }

  function bindTheirNameInput(el) {
    const input = el.querySelector("#zc-their-name");
    if (!input || input.dataset.zcBound === "1") return;
    input.dataset.zcBound = "1";
    input.addEventListener("input", () => syncTheirNameFromInput(el));
    input.addEventListener("change", () => syncTheirNameFromInput(el));
  }

  function buildStep2HeroTimeInputHtml(id, sideClass, hour, minute, ariaLabel) {
    return `<input type="text" class="zc-step2-time-large zc-step2-time-input ${sideClass}" id="${id}" value="${escAttr(formatHourClock12(hour, minute))}" inputmode="text" aria-label="${escAttr(ariaLabel)}" spellcheck="false" autocomplete="off" />`;
  }

  function getActiveScheduleState() {
    if (activePopover?.classList.contains("zc-popover-step1")) return step1State;
    return step2State;
  }

  function refreshActiveScheduleStep(el, opts = {}) {
    if (el.classList.contains("zc-popover-step1")) refreshStep1(el, opts);
    else refreshStep2(el, opts);
  }

  function syncHeroTimeInputValue(input, which) {
    const s = getActiveScheduleState();
    const hour = which === "their" ? s.theirHour : s.yourHour;
    const minute = which === "their" ? s.theirMinute : s.yourMinute;
    input.value = formatHourClock12(hour, minute);
  }

  function commitHeroTimeInput(el, which, input) {
    const parsed = parseTimeInput(input.value);
    if (!parsed) {
      syncHeroTimeInputValue(input, which);
      return;
    }

    const s = getActiveScheduleState();
    if (which === "their") {
      s.theirHour = parsed.hour;
      s.theirMinute = parsed.minute;
      const y = convertTime(
        { timezone: s.theirTz, hour: parsed.hour, minute: parsed.minute, date: s.theirDate },
        s.yourTz
      );
      s.yourHour = y.hour;
      s.yourMinute = y.minute;
      s.yourDate = y.date;
    } else {
      s.yourHour = parsed.hour;
      s.yourMinute = parsed.minute;
      const t = convertTime(
        { timezone: s.yourTz, hour: parsed.hour, minute: parsed.minute, date: s.yourDate },
        s.theirTz
      );
      s.theirHour = t.hour;
      s.theirMinute = t.minute;
      s.theirDate = t.date;
    }
    refreshActiveScheduleStep(el);
  }

  function bindHeroTimeInput(el, which, selector) {
    const input = el.querySelector(selector);
    if (!input || input.dataset.zcBound === "1") return;
    input.dataset.zcBound = "1";
    let revertValue = input.value;

    input.addEventListener("focus", () => {
      syncHeroTimeInputValue(input, which);
      revertValue = input.value;
      input.select();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        input.dataset.zcCancel = "1";
        input.value = revertValue;
        input.blur();
      }
    });

    input.addEventListener("blur", () => {
      if (input.dataset.zcCancel === "1") {
        delete input.dataset.zcCancel;
        return;
      }
      commitHeroTimeInput(el, which, input);
    });
  }

  function bindHeroTimeInputs(el) {
    bindHeroTimeInput(el, "their", "#zc-their-large");
    bindHeroTimeInput(el, "yours", "#zc-your-large");
  }

  function applyScheduleTimezoneChange(s, which, newTz) {
    if (which === "their") {
      s.theirTz = newTz;
      s.theirTzEmailLabel = null;
      const reconv = convertTime(
        s.timeObj
          ? { ...s.timeObj, timezone: newTz, hour: s.theirHour, minute: s.theirMinute, date: s.theirDate }
          : { timezone: newTz, hour: s.theirHour, minute: s.theirMinute, date: s.theirDate },
        s.yourTz
      );
      s.yourHour = reconv.hour;
      s.yourMinute = reconv.minute;
      s.yourDate = reconv.date;
    } else {
      s.yourTz = newTz;
      const reconv = convertTime(
        { timezone: s.theirTz, hour: s.theirHour, minute: s.theirMinute, date: s.theirDate },
        newTz
      );
      s.yourHour = reconv.hour;
      s.yourMinute = reconv.minute;
      s.yourDate = reconv.date;
    }
  }

  function bindScheduleTimelineDrag(el) {
    const beginScheduleDrag = (e) => {
      const marker = e.target.closest(".zc-marker-drag");
      if (!marker) return;
      const stage = marker.closest(".zc-timeline-stage");
      const track = stage?.querySelector(".zc-timeline-interactive");
      if (!track) return;
      e.preventDefault();
      e.stopPropagation();
      dragState = {
        dragging: marker.dataset.id,
        trackEl: track,
        trackTz: track.dataset.tz,
        trackDate: track.dataset.date,
        pointerId: e.pointerId ?? null,
      };
      marker.classList.add("zc-marker-dragging");
      track.classList.add("zc-timeline-dragging");
      if (typeof marker.setPointerCapture === "function" && e.pointerId != null) {
        try {
          marker.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    };

    if (window.PointerEvent) {
      el.addEventListener("pointerdown", beginScheduleDrag);
    } else {
      el.addEventListener("mousedown", beginScheduleDrag);
    }
  }

  function stepTimelineLegendHtml() {
    const name = escHtml(theirNameLabel());
    return `<div class="zc-step2-legend">
          <span class="zc-legend-item"><span class="zc-legend-line zc-legend-line-blue"></span> <span class="zc-legend-their-name">${name}</span></span>
          <span class="zc-legend-item"><span class="zc-legend-line zc-legend-line-you"></span> You</span>
          <span class="zc-legend-item"><span class="zc-legend-bh-swatch zc-legend-shared-hours-swatch"></span> Shared scheduling window</span>
        </div>`;
  }

  // ─── Selection listener ───────────────────────────────────────────────────

  document.addEventListener("mouseup", (e) => {
    if (activePopover && activePopover.contains(e.target)) return;

    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text || text.length < 3) return;

    const node = selection.anchorNode;
    if (!node) return;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el.closest('[data-message-id], .a3s, .ii')) return;

    activeRange = selection.getRangeAt(0).cloneRange();
    selectionAnchorRect = activeRange.getBoundingClientRect();
    handleSelection(text, e);
  });

  document.addEventListener("mousedown", (e) => {
    if (activePopover && !activePopover.contains(e.target)) {
      closePopover();
    }
  });

  // ─── Selection handler ────────────────────────────────────────────────────

  function handleSelection(text, mouseEvent) {
    closePopover();
    showLoadingPopover(mouseEvent);

    const messageText = getEmailMessageTextNearSelection();
    lastDetectMessageContext = messageText;

    sendToBackground(
      {
        type: "DETECT_TIME",
        text,
        messageText,
        viewerLocalDate: viewerLocalDateYmdInTz(userTimezone),
        viewerTimeZone: userTimezone,
      },
      (response) => {
        closePopover();
        if (!response || !response.success) {
          showErrorPopover(
            response?.error || "Could not detect a time in the selected text.",
            mouseEvent
          );
          return;
        }
        if (!response.times || response.times.length === 0) {
          showNoTimeDetectedPopover();
          return;
        }

        detectedTimes = response.times;
        theirDisplayName = resolveTheirDisplayName(response.senderName);
        const timeObj = response.times[0];
        injectPill(timeObj);
        showStep1Popover(timeObj);
      }
    );
  }

  // ─── Pill injection ───────────────────────────────────────────────────────

  function injectPill(timeObj) {
    if (!activeRange) return;
    removePill();

    const pill = document.createElement("span");
    pill.className = "zc-pill";
    pill.textContent = timeObj.original;
    activePill = pill;

    try {
      activeRange.deleteContents();
      activeRange.insertNode(pill);
      selectionAnchorRect = pill.getBoundingClientRect();
    } catch {
      // range may be invalid if DOM changed
    }
  }

  function removePill() {
    if (activePill) {
      const parent = activePill.parentNode;
      if (parent) {
        while (activePill.firstChild) {
          parent.insertBefore(activePill.firstChild, activePill);
        }
        parent.removeChild(activePill);
      }
      activePill = null;
    }
  }

  // ─── Popover positioning ──────────────────────────────────────────────────
  // FIX: Gmail's main content area can have CSS transforms that break
  // getBoundingClientRect() → absolute positioning. We use fixed positioning
  // relative to the viewport instead, which is immune to ancestor transforms.

  function getPopoverWidth(popover) {
    return popover.classList.contains("zc-popover-step3") ||
      popover.classList.contains("zc-popover-step2") ||
      popover.classList.contains("zc-popover-step1") ||
      popover.classList.contains("zc-popover-empty")
      ? 384
      : 380;
  }

  function clampPopoverViewportPosition(left, top, popover) {
    const margin = 8;
    const width = popover.offsetWidth || getPopoverWidth(popover);
    const height = popover.offsetHeight || 400;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    return {
      top: Math.min(Math.max(top, margin), maxTop),
      left: Math.min(Math.max(left, margin), maxLeft),
    };
  }

  function rememberPopoverViewportPosition(popover) {
    if (!popover?.isConnected) return;
    const rect = popover.getBoundingClientRect();
    popoverViewportPosition = clampPopoverViewportPosition(rect.left, rect.top, popover);
  }

  function captureActivePopoverViewportPosition() {
    if (activePopover?.isConnected) rememberPopoverViewportPosition(activePopover);
  }

  function replaceActivePopover(popover) {
    captureActivePopoverViewportPosition();
    closeTzPicker();
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
    dragState = null;
    popoverDragState = null;
    activePopover = popover;
  }

  function getHighlightAnchorRect() {
    if (activePill?.isConnected) {
      const pillRect = activePill.getBoundingClientRect();
      if (pillRect.width > 0 || pillRect.height > 0) return pillRect;
    }
    if (activeRange) {
      try {
        const rangeRect = activeRange.getBoundingClientRect();
        if (rangeRect.width > 0 || rangeRect.height > 0) return rangeRect;
      } catch {
        /* ignore */
      }
    }
    return selectionAnchorRect;
  }

  function popoverPlacementIntersectsHighlight(left, top, popW, popH) {
    const highlightRect = getHighlightAnchorRect();
    if (!highlightRect) return false;
    const placement = { left, top, right: left + popW, bottom: top + popH };
    return !(
      placement.right <= highlightRect.left ||
      placement.left >= highlightRect.right ||
      placement.bottom <= highlightRect.top ||
      placement.top >= highlightRect.bottom
    );
  }

  function computePopoverDefaultPosition(popover) {
    const defaultTop = 120;
    const defaultRight = 80;
    const defaultBottom = 80;
    const margin = 8;
    void popover.offsetHeight;
    const popW = popover.offsetWidth || getPopoverWidth(popover);
    const popH = popover.offsetHeight || 400;

    let top = defaultTop;
    let left = window.innerWidth - defaultRight - popW;
    const topRightFits =
      top >= margin && top + popH <= window.innerHeight - margin;
    const topRightClear =
      topRightFits && !popoverPlacementIntersectsHighlight(left, top, popW, popH);

    if (!topRightClear) {
      top = window.innerHeight - defaultBottom - popH;
      left = window.innerWidth - defaultRight - popW;
    }

    return clampPopoverViewportPosition(left, top, popover);
  }

  function positionPopover(popover) {
    popover.style.position = "fixed";
    document.body.appendChild(popover);

    const applied = popoverViewportPosition
      ? clampPopoverViewportPosition(
          popoverViewportPosition.left,
          popoverViewportPosition.top,
          popover
        )
      : computePopoverDefaultPosition(popover);

    popover.style.top = `${applied.top}px`;
    popover.style.left = `${applied.left}px`;
    popoverViewportPosition = { top: applied.top, left: applied.left };
    bindPopoverDrag(popover);
  }

  // ─── Loading popover ──────────────────────────────────────────────────────

  function showLoadingPopover(mouseEvent) {
    const el = document.createElement("div");
    el.className = "zc-popover";
    el.style.position = "fixed";
    el.innerHTML = `<div class="zc-loading"><div class="zc-spinner"></div><span>Detecting time…</span></div>`;
    activePopover = el;
    document.body.appendChild(el);

    el.style.top = `${mouseEvent.clientY + 12}px`;
    el.style.left = `${Math.min(mouseEvent.clientX, window.innerWidth - 396)}px`;
  }

  // ─── Empty state (no times in selection) ─────────────────────────────────

  function showNoTimeDetectedPopover() {
    replaceActivePopover(null);
    const el = document.createElement("div");
    el.className = "zc-popover zc-popover-empty";
    el.innerHTML = `
      <div class="zc-header">
        <div class="zc-header-nav" aria-hidden="true"></div>
        <span class="zc-title">Zonecheck</span>
        <div class="zc-header-actions">
          <button class="zc-close" aria-label="Close">×</button>
        </div>
      </div>
      <div class="zc-empty-state-body">
        <div class="zc-schedule-hint zc-schedule-hint-detection" role="status">
          <div class="zc-detection-hint-head">
            ${noTimeDetectedIconHtml()}
            <span class="zc-detection-hint-title">No time detected yet</span>
          </div>
          <p class="zc-detection-hint-sub">Highlight a time in the email to compare schedules.</p>
        </div>
      </div>`;
    activePopover = el;
    el.querySelector(".zc-close").addEventListener("click", closePopover);
    positionPopover(el);
  }

  // ─── Error popover ────────────────────────────────────────────────────────

  function showErrorPopover(msg, mouseEvent) {
    const el = document.createElement("div");
    el.className = "zc-popover";
    el.style.position = "fixed";
    el.innerHTML = `
      <div class="zc-header">
        <div class="zc-header-nav" aria-hidden="true"></div>
        <span class="zc-title">Zonecheck</span>
        <div class="zc-header-actions">
          <button class="zc-close" aria-label="Close">×</button>
        </div>
      </div>
      <div class="zc-error-body">
        <span class="zc-status-pill zc-pill-red">${escHtml(msg)}</span>
      </div>`;
    el.querySelector(".zc-close").addEventListener("click", closePopover);
    bindPopoverDrag(el);
    activePopover = el;
    document.body.appendChild(el);
    el.style.top = `${mouseEvent.clientY + 12}px`;
    el.style.left = `${Math.min(mouseEvent.clientX, window.innerWidth - 396)}px`;
  }

  // ─── Step 1 — Time conversion + availability ──────────────────────────────

  let step1State = {};
  let lastDraftScheduleState = null;

  function buildStep1Html() {
    const s = step1State;

    return `
      <div class="zc-header">
        <div class="zc-header-nav" aria-hidden="true"></div>
        <span class="zc-title">Zonecheck</span>
        <div class="zc-header-actions">
          <button class="zc-close" aria-label="Close">×</button>
        </div>
      </div>
      <div class="zc-step2-body">
        ${buildTimelineDragHintHtml()}

        <section class="zc-section zc-section-hero">
        <div class="zc-step2-hero">
          <div class="zc-step2-hero-side">
            <div class="zc-step2-hero-rail zc-step2-hero-rail-left">
            ${theirNameFieldHtml()}
            ${buildStep2HeroTimeInputHtml("zc-their-large", "zc-step2-their-clock", s.theirHour, s.theirMinute, "Their time")}
            <div class="zc-step2-meta">
              <div class="zc-step2-date" id="zc-their-date">${formatDate(s.theirDate, s.theirTz)}</div>
              ${buildSourceBadgeHtml("detected")}
            </div>
            ${buildTimezoneSelectHtml("their", s.theirTz)}
            </div>
          </div>
          <div class="zc-step2-hero-side zc-step2-hero-right">
            <div class="zc-step2-hero-rail zc-step2-hero-rail-right">
            <div class="zc-step2-who">You</div>
            <div class="zc-step2-hero-time-row">
              ${buildStep2HeroTimeInputHtml("zc-your-large", "zc-step2-your-clock", s.yourHour, s.yourMinute, "Your time")}
              <span class="zc-step2-cross-day" id="zc-your-cross-day">${buildCrossDay(s.theirDate, s.yourDate)}</span>
            </div>
            <div class="zc-step2-meta">
              <div class="zc-step2-date" id="zc-your-date">${formatDate(s.yourDate, s.yourTz)}</div>
              ${buildSourceBadgeHtml("settings")}
            </div>
            ${buildTimezoneSelectHtml("your", s.yourTz)}
            </div>
          </div>
        </div>
        </section>

        <section class="zc-section zc-section-timeline">
        ${buildScheduleTimelineHtml(s, true, { dragAreaId: "zc-drag-area" })}
        ${stepTimelineLegendHtml()}
        </section>

        <div class="zc-step2-hours-slot" id="zc-step1-hours-notice">${buildStep2HoursNoticeHtml(s)}</div>

        <div class="zc-step1-footer">
          <div class="zc-footer-decision-row">
            <button class="zc-btn zc-btn-yes-soft" data-action="yes">Yes, works for me</button>
            <button class="zc-btn zc-btn-no-soft" data-action="no">Can't make it</button>
          </div>
          <button class="zc-btn zc-btn-suggest-soft" data-action="suggest">Suggest another time</button>
        </div>
      </div>`;
  }

  function refreshStep1(el, opts = {}) {
    const s = step1State;

    const theirLargeEl = el.querySelector("#zc-their-large");
    const yourLargeEl = el.querySelector("#zc-your-large");
    const theirDateEl = el.querySelector("#zc-their-date");
    const yourDateEl = el.querySelector("#zc-your-date");
    const crossDayEl = el.querySelector("#zc-your-cross-day");

    if (theirLargeEl && theirLargeEl !== document.activeElement) {
      theirLargeEl.value = formatHourClock12(s.theirHour, s.theirMinute);
    }
    if (yourLargeEl && yourLargeEl !== document.activeElement) {
      yourLargeEl.value = formatHourClock12(s.yourHour, s.yourMinute);
    }
    if (theirDateEl) theirDateEl.textContent = formatDate(s.theirDate, s.theirTz);
    if (yourDateEl) yourDateEl.textContent = formatDate(s.yourDate, s.yourTz);
    if (crossDayEl) crossDayEl.innerHTML = buildCrossDay(s.theirDate, s.yourDate);
    syncTimezoneSelects(el, s);

    const noticeSlot = el.querySelector("#zc-step1-hours-notice");
    if (noticeSlot) noticeSlot.innerHTML = buildStep2HoursNoticeHtml(s);

    const dragArea = el.querySelector("#zc-drag-area");
    if (!dragArea) return;

    if (opts.skipTimelineRebuild && dragState) {
      updateStep2MarkerPositions(dragArea, s);
      return;
    }

    dragArea.outerHTML = buildScheduleTimelineHtml(s, true, { dragAreaId: "zc-drag-area" });
    updateTheirNameLabels(el);
    const rebuilt = el.querySelector("#zc-drag-area");
    if (rebuilt) updateStep2MarkerPositions(rebuilt, s);
  }

  function showStep1Popover(timeObj) {
    replaceActivePopover(null);

    if (step2State?.theirName) {
      theirDisplayName = step2State.theirName;
    }
    const theirTz = resolveTheirIanaFromDetection(timeObj, lastDetectMessageContext);
    const yourTz = userTimezone;

    const theirTzEmailLabel =
      extractTimezoneAbbrFromText(timeObj.original) ||
      extractTimezoneAbbrFromText(lastDetectMessageContext) ||
      extractEmailTimezoneLabel(timeObj.timezone) ||
      null;

    const converted = convertTime({ ...timeObj, timezone: theirTz }, yourTz);

    step1State = {
      timeObj,
      theirTz,
      yourTz,
      theirHour: timeObj.hour,
      theirMinute: timeObj.minute || 0,
      theirDate: timeObj.date,
      yourHour: converted.hour,
      yourMinute: converted.minute,
      yourDate: converted.date,
      theirName: theirNameLabel(),
      theirTzEmailLabel,
    };

    const el = document.createElement("div");
    el.className = "zc-popover zc-popover-step1";
    el.innerHTML = buildStep1Html();
    activePopover = el;
    bindTheirNameInput(el);
    bindHeroTimeInputs(el);
    bindTimezoneSelects(el);
    bindScheduleTimelineDrag(el);

    el.querySelector(".zc-close").addEventListener("click", closePopover);
    el.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        const s = step1State;
        const yourConverted = {
          hour: s.yourHour,
          minute: s.yourMinute,
          date: s.yourDate,
        };
        if (action === "yes") {
          startDraftGeneration("yes", timeObj, s.theirTz, s.yourTz, yourConverted, el);
        } else if (action === "no") {
          startDraftGeneration("no", timeObj, s.theirTz, s.yourTz, yourConverted, el);
        } else {
          syncTheirNameFromInput(el);
          showStep2Popover(timeObj, s.theirTz, s.yourTz);
        }
      });
    });

    positionPopover(el);
    requestAnimationFrame(() => {
      const da = el.querySelector("#zc-drag-area");
      if (da) updateStep2MarkerPositions(da, step1State);
    });
  }

  function buildCrossDay(theirDate, yourDate) {
    if (theirDate === yourDate) return "";
    const tD = new Date(theirDate);
    const yD = new Date(yourDate);
    const diff = Math.round((yD - tD) / 86400000);
    if (diff === 1) return `<span class="zc-plus1">+1</span>`;
    if (diff === -1) return `<span class="zc-plus1">-1</span>`;
    return `<span class="zc-plus1">${diff > 0 ? "+" : ""}${diff}</span>`;
  }

  // ─── Timeline component ───────────────────────────────────────────────────

  /** Two rails only when the meeting spans different calendar dates in each zone; otherwise one shared rail. */
  function timelinesSplitOnDifferentDays(theirDate, yourDate) {
    return theirDate !== yourDate;
  }

  function buildScheduleTimelineHtml(t, interactive, opts = {}) {
    const { theirHour, theirMinute, theirDate, theirTz, yourHour, yourMinute, yourDate, yourTz } = t;
    const theirPos = hourToPercent(theirHour + theirMinute / 60);
    const yourPos = hourToPercent(yourHour + yourMinute / 60);
    const theirMarker = {
      pos: theirPos,
      label: formatHour(theirHour, theirMinute),
      color: "blue",
      id: "their",
    };
    const yourMarker = {
      pos: yourPos,
      label: formatHour(yourHour, yourMinute),
      color: "green",
      id: "yours",
    };
    const split = timelinesSplitOnDifferentDays(theirDate, yourDate);
    const wrapCls = `zc-timeline-wrap${interactive ? " zc-interactive" : ""}${split ? " zc-timeline-wrap-split" : ""}`;
    const idAttr = opts.dragAreaId ? ` id="${escAttr(opts.dragAreaId)}"` : "";

    if (!split) {
      return `<div${idAttr} class="${wrapCls}">${buildRailsTimelineDay(
        theirDate,
        theirTz,
        [theirMarker, yourMarker],
        interactive,
        null,
        null,
        theirTz,
        yourTz,
        yourDate,
        theirDate
      )}</div>`;
    }

    return `<div${idAttr} class="${wrapCls}">${buildRailsTimelineDay(
      yourDate,
      yourTz,
      [yourMarker],
      interactive,
      "You",
      null,
      theirTz,
      yourTz,
      yourDate,
      theirDate
    )}${buildRailsTimelineDay(
      theirDate,
      theirTz,
      [theirMarker],
      interactive,
      theirNameLabel(),
      "their",
      theirTz,
      yourTz,
      yourDate,
      theirDate
    )}</div>`;
  }

  function buildTimeline(theirHour, theirMinute, yourHour, yourMinute, theirDate, yourDate, theirTz, yourTz, interactive) {
    return buildScheduleTimelineHtml(
      { theirHour, theirMinute, theirDate, theirTz, yourHour, yourMinute, yourDate, yourTz },
      interactive
    );
  }

  /** Map a time-of-day (0–24h) to a track percentage; 12:00 → 50%, 12:30 → 52.08%. */
  function hourToPercent(h) {
    const clamped = Math.min(24, Math.max(0, h));
    if (clamped >= 24) return 100;
    return Math.round((clamped / 24) * 10000) / 100;
  }

  function bhHourToPercent(h) {
    return h >= 24 ? 100 : hourToPercent(h);
  }

  const MARKER_LINE_WIDTH_PX = 2;
  /** Keep marker line inside rounded track corners (px beyond half line width). */
  const TIMELINE_CORNER_CLEAR_PX = 2;
  /** Minimum horizontal gap between chip labels on the same row (px). */
  const CHIP_PAIR_GAP_PX = 2;
  /** Extra clearance required before leaving stacked mode (reduces jitter at boundary). */
  const CHIP_UNSTACK_HYSTERESIS_PX = 8;
  /** Chip label must stay inside rail; inset from inner rail edge (not section/card padding). */
  const CHIP_EDGE_INSET_PX = 4;

  function lineCenterPxFromTimePercent(posPct, railWidthPx) {
    const W = railWidthPx;
    if (!W) return 0;
    const t = Math.min(100, Math.max(0, posPct));
    const anchor = (t / 100) * W;
    const edge = MARKER_LINE_WIDTH_PX / 2 + TIMELINE_CORNER_CLEAR_PX;
    if (W <= edge * 2) return W / 2;
    return Math.min(W - edge, Math.max(edge, anchor));
  }

  /** Clamp chip center so the label box stays inside [inset, W-inset]. */
  function chipCenterPxClampedToRail(lineCenterPx, labelWidthPx, railWidthPx) {
    const W = railWidthPx;
    const lw = labelWidthPx || 0;
    const pad = CHIP_EDGE_INSET_PX;
    if (!W) return lineCenterPx;
    const half = lw / 2 + pad;
    if (half * 2 >= W) return W / 2;
    return Math.min(W - half, Math.max(half, lineCenterPx));
  }

  let markerLayoutFlushScheduled = false;
  const markerLayoutByDragArea = new Map();

  function scheduleTimelineMarkerLayoutMeasure(dragArea, s) {
    markerLayoutByDragArea.set(dragArea, s);
    if (markerLayoutFlushScheduled) return;
    markerLayoutFlushScheduled = true;
    requestAnimationFrame(() => {
      markerLayoutFlushScheduled = false;
      markerLayoutByDragArea.forEach((st, area) => {
        if (area.isConnected) syncTimelineMarkerChipLayoutMeasured(area, st);
      });
      markerLayoutByDragArea.clear();
    });
  }

  function applyTimelineMarkerPositionsForStage(stage, s) {
    const track = stage.querySelector(".zc-timeline-step2-track");
    const W = track?.getBoundingClientRect().width || 0;
    if (!W) return;
    stage.querySelectorAll(".zc-marker-line-only[data-id]").forEach((lineEl) => {
      const id = lineEl.dataset.id;
      const hour = id === "their" ? s.theirHour : s.yourHour;
      const minute = id === "their" ? s.theirMinute : s.yourMinute;
      const pos = hourToPercent(hour + minute / 60);
      const lineCx = lineCenterPxFromTimePercent(pos, W);
      const linePct = (lineCx / W) * 100;
      lineEl.style.left = `${linePct}%`;
      const chip = stage.querySelector(`.zc-marker-chip-only[data-id="${id}"]`);
      if (!chip) return;
      chip.style.left = `${linePct}%`;
      chip.style.setProperty("--zc-chip-nudge", "0px");
      chip.style.removeProperty("--zc-chip-stack-y");
      chip.classList.remove("zc-chip-stack-row1", "zc-chip-stack-row2", "zc-chip-hug-left", "zc-chip-hug-right");
      const label = chip.querySelector(".zc-marker-label");
      if (label) label.textContent = formatHour(hour, minute);
    });
  }

  function finalizeTimelineStageChipAreaHeight(stage, track) {
    const gap = CHIP_PAIR_GAP_PX;
    const chips = [...stage.querySelectorAll(".zc-marker-chip-only[data-id]")];
    if (chips.length === 0) {
      stage.style.removeProperty("--zc-stage-chip-below-h");
      return;
    }
    if (chips.length === 1) {
      const h = Math.ceil(chips[0].getBoundingClientRect().height || 18);
      stage.style.setProperty("--zc-stage-chip-below-h", `${2 + h}px`);
      return;
    }
    const theirChip = chips.find((c) => c.dataset.id === "their");
    const yoursChip = chips.find((c) => c.dataset.id === "yours");
    if (!theirChip || !yoursChip) {
      const h = Math.max(
        ...chips.map((c) => Math.ceil(c.getBoundingClientRect().height || 18)),
        18
      );
      stage.style.setProperty("--zc-stage-chip-below-h", `${2 + h}px`);
      return;
    }
    const stacked = stage.dataset.zcChipStacked === "1";
    const ht = Math.ceil(theirChip.getBoundingClientRect().height || 18);
    const hy = Math.ceil(yoursChip.getBoundingClientRect().height || 18);
    if (stacked) {
      stage.style.setProperty("--zc-stage-chip-below-h", `${2 + ht + gap + hy}px`);
    } else {
      stage.style.setProperty("--zc-stage-chip-below-h", `${2 + Math.max(ht, hy)}px`);
    }
  }

  function layoutSoloTimelineChip(stage, chip, s, W) {
    void stage;
    const id = chip.dataset.id;
    const hour = id === "their" ? s.theirHour : s.yourHour;
    const minute = id === "their" ? s.theirMinute : s.yourMinute;
    const pos = hourToPercent(hour + minute / 60);
    const lineCx = lineCenterPxFromTimePercent(pos, W);
    const label = chip.querySelector(".zc-marker-label");
    const lw = label?.getBoundingClientRect().width ?? 0;
    const chipCx = chipCenterPxClampedToRail(lineCx, lw, W);
    const nudge = chipCx - lineCx;
    chip.style.setProperty("--zc-chip-nudge", `${Math.round(nudge * 100) / 100}px`);
    chip.style.removeProperty("--zc-chip-stack-y");
    chip.classList.remove("zc-chip-stack-row1", "zc-chip-stack-row2");
    chip.classList.toggle("zc-chip-hug-left", nudge > 0.5);
    chip.classList.toggle("zc-chip-hug-right", nudge < -0.5);
  }

  function syncTimelineMarkerChipLayoutMeasured(dragArea, s) {
    dragArea.querySelectorAll(".zc-timeline-stage").forEach((stage) => {
      const track = stage.querySelector(".zc-timeline-step2-track");
      const W = track?.getBoundingClientRect().width || 0;
      if (!W || !track) return;

      const chips = [...stage.querySelectorAll(".zc-marker-chip-only[data-id]")];
      const wasStacked = stage.dataset.zcChipStacked === "1";

      chips.forEach((chip) => {
        chip.classList.remove("zc-chip-stack-row1", "zc-chip-stack-row2", "zc-chip-hug-left", "zc-chip-hug-right");
        chip.style.removeProperty("--zc-chip-stack-y");
      });

      if (chips.length < 2) {
        chips.forEach((chip) => layoutSoloTimelineChip(stage, chip, s, W));
        delete stage.dataset.zcChipStacked;
        finalizeTimelineStageChipAreaHeight(stage, track);
        return;
      }

      const resolved = chips.map((chip) => {
        const id = chip.dataset.id;
        const hour = id === "their" ? s.theirHour : s.yourHour;
        const minute = id === "their" ? s.theirMinute : s.yourMinute;
        const pos = hourToPercent(hour + minute / 60);
        const lineCx = lineCenterPxFromTimePercent(pos, W);
        const label = chip.querySelector(".zc-marker-label");
        const lw = label?.getBoundingClientRect().width ?? 0;
        const chipCx = chipCenterPxClampedToRail(lineCx, lw, W);
        return { chip, id, lineCx, lw, chipCx };
      });

      const their = resolved.find((x) => x.id === "their");
      const yours = resolved.find((x) => x.id === "yours");
      if (!their || !yours) {
        resolved.forEach((x) => layoutSoloTimelineChip(stage, x.chip, s, W));
        delete stage.dataset.zcChipStacked;
        finalizeTimelineStageChipAreaHeight(stage, track);
        return;
      }

      const [left, right] = their.chipCx <= yours.chipCx ? [their, yours] : [yours, their];
      const sep = right.chipCx - right.lw / 2 - (left.chipCx + left.lw / 2);
      const gapOk = sep >= CHIP_PAIR_GAP_PX;
      const useStack = wasStacked
        ? sep < CHIP_PAIR_GAP_PX + CHIP_UNSTACK_HYSTERESIS_PX
        : !gapOk;

      const applyPairNudges = () => {
        for (const x of [their, yours]) {
          const nudge = x.chipCx - x.lineCx;
          x.chip.style.setProperty("--zc-chip-nudge", `${Math.round(nudge * 100) / 100}px`);
          x.chip.classList.toggle("zc-chip-hug-left", nudge > 0.5);
          x.chip.classList.toggle("zc-chip-hug-right", nudge < -0.5);
        }
      };

      applyPairNudges();

      if (!useStack) {
        their.chip.classList.remove("zc-chip-stack-row1", "zc-chip-stack-row2");
        yours.chip.classList.remove("zc-chip-stack-row1", "zc-chip-stack-row2");
        their.chip.style.removeProperty("--zc-chip-stack-y");
        yours.chip.style.removeProperty("--zc-chip-stack-y");
        delete stage.dataset.zcChipStacked;
        finalizeTimelineStageChipAreaHeight(stage, track);
        return;
      }

      stage.dataset.zcChipStacked = "1";
      their.chip.classList.add("zc-chip-stack-row1");
      yours.chip.classList.add("zc-chip-stack-row2");
      their.chip.style.setProperty("--zc-chip-stack-y", "0px");
      yours.chip.style.setProperty("--zc-chip-stack-y", "0px");
      void stage.offsetHeight;
      const hTheir = Math.ceil(their.chip.getBoundingClientRect().height || 18);
      const row2Offset = hTheir + CHIP_PAIR_GAP_PX;
      yours.chip.style.setProperty("--zc-chip-stack-y", `${row2Offset}px`);
      finalizeTimelineStageChipAreaHeight(stage, track);
    });
  }

  function updateStep2MarkerPositions(dragArea, s) {
    if (!dragArea) return;
    dragArea.querySelectorAll(".zc-timeline-stage").forEach((stage) => applyTimelineMarkerPositionsForStage(stage, s));
    scheduleTimelineMarkerLayoutMeasure(dragArea, s);
  }

  function step2TickLabel(hour) {
    if (hour === 0 || hour === 24) return "12am";
    if (hour === 12) return "12pm";
    return formatHour(hour);
  }

  /** Wall time as fraction of 24h on `railDate` in `railTz`, or null if that instant is another calendar date there. */
  function fractionalDayHourOnRail(utcMs, railDate, railTz) {
    const w = wallClockPartsFromUtcMs(utcMs, railTz);
    if (!w.date || w.date !== railDate) return null;
    return w.hour + w.minute / 60 + (w.second || 0) / 3600;
  }

  /**
   * Coordination gradient on 0–24h axis: `left = (startFrac/24)*100`, `width = ((endFrac-startFrac)/24)*100`
   * (`tzYours` / `axisDateYmd`). See `coordinationWindowFracsOnUserAxis`.
   */
  function mutualOverlapBandPercents(axisDateYmd, theirDateYmd, tzTheir, tzYours) {
    const fracs = coordinationWindowFracsOnUserAxis(
      axisDateYmd,
      theirDateYmd,
      tzTheir,
      tzYours,
      businessHours
    );
    if (!fracs) return null;
    const { startFrac, endFrac } = fracs;
    const leftPct = (startFrac / 24) * 100;
    const widthPct = ((endFrac - startFrac) / 24) * 100;
    if (widthPct <= 0) return null;
    return { leftPct, widthPct };
  }

  function buildMutualOverlapHighlightHtml(band) {
    if (!band) return "";
    const { leftPct, widthPct } = band;
    return `<div class="zc-bh-overlap-highlight zc-bh-step2" style="left:${leftPct}%;width:${widthPct}%"></div>`;
  }

  function buildRailsTimelineDay(
    date,
    tz,
    markers,
    interactive,
    whoLabel,
    dayKind,
    tzTheir,
    tzYours,
    axisDateYmd,
    theirDateYmd
  ) {
    const dayLabel = whoLabel ? `${whoLabel} · ${formatDate(date, tz)}` : formatDate(date, tz);
    const dayCls = `zc-timeline-day zc-timeline-day-step2${dayKind === "their" ? " zc-timeline-day-their" : ""}`;
    const dragClass = interactive ? " zc-marker-drag" : "";
    const markerLinesHtml = markers
      .map(
        (m) =>
          `<div class="zc-marker zc-marker-${m.color} zc-marker-step2 zc-marker-line-only${dragClass}"
            style="left:${m.pos}%"
            data-id="${m.id}"
            title="${escAttr(m.label)}">
        <div class="zc-marker-line"></div>
      </div>`
      )
      .join("");
    const markerChipsHtml = markers
      .map(
        (m) =>
          `<div class="zc-marker zc-marker-${m.color} zc-marker-step2 zc-marker-chip-only"
            style="left:${m.pos}%"
            data-id="${m.id}">
        <div class="zc-marker-label">${escHtml(m.label)}</div>
      </div>`
      )
      .join("");

    const tickHours = [0, 6, 12, 18, 24];
    const ticksAboveHtml =
      `<div class="zc-ticks-above" aria-hidden="true">` +
      tickHours
        .map((h) => {
          const pct = bhHourToPercent(h);
          return `<span class="zc-tick zc-tick-above" style="left:${pct}%">${step2TickLabel(h)}</span>`;
        })
        .join("") +
      `</div>`;

    const railInteractive = interactive ? "zc-timeline-interactive" : "";
    const band = mutualOverlapBandPercents(
      axisDateYmd || date,
      theirDateYmd || date,
      tzTheir,
      tzYours
    );
    const noMutualCls = band ? "" : " zc-timeline-step2-track--no-mutual";
    const mutualBandsHtml = band
      ? `<div class="zc-bh-inactive zc-bh-step2" style="left:0;width:${band.leftPct}%"></div>
              <div class="zc-bh-inactive zc-bh-step2" style="left:${band.leftPct + band.widthPct}%;width:${100 - band.leftPct - band.widthPct}%"></div>
              ${buildMutualOverlapHighlightHtml(band)}`
      : `<div class="zc-bh-inactive zc-bh-step2" style="left:0;width:100%"></div>`;

    return `
      <div class="${dayCls}" data-date="${escAttr(date)}" data-tz="${escAttr(tz)}">
        <div class="zc-timeline-day-label">${dayLabel}</div>
        <div class="zc-timeline-with-ticks">
          ${ticksAboveHtml}
          <div class="zc-timeline-stage">
            <div class="zc-timeline ${railInteractive} zc-timeline-step2-track${noMutualCls}" data-tz="${escAttr(tz)}" data-date="${escAttr(date)}">
              ${mutualBandsHtml}
              <div class="zc-timeline-marker-lines-clip">${markerLinesHtml}</div>
            </div>
            <div class="zc-timeline-markers">${markerChipsHtml}</div>
          </div>
        </div>
      </div>`;
  }

  // ─── Step 2 — Draggable timeline ──────────────────────────────────────────

  let step2State = {};

  function showStep2Popover(timeObj, theirTz, yourTz) {
    replaceActivePopover(null);

    const converted = convertTime({ ...timeObj, timezone: theirTz }, yourTz);

    step2State = {
      timeObj,
      theirTz,
      yourTz,
      theirHour: timeObj.hour,
      theirMinute: timeObj.minute || 0,
      theirDate: timeObj.date,
      yourHour: converted.hour,
      yourMinute: converted.minute,
      yourDate: converted.date,
      theirName: theirNameLabel(),
      theirTzEmailLabel:
        extractTimezoneAbbrFromText(timeObj.original) ||
        extractEmailTimezoneLabel(timeObj.timezone) ||
        step1State?.theirTzEmailLabel ||
        null,
    };

    const el = document.createElement("div");
    el.className = "zc-popover zc-popover-step2";
    el.innerHTML = buildStep2Html();
    activePopover = el;
    bindTheirNameInput(el);
    bindHeroTimeInputs(el);
    bindTimezoneSelects(el);

    el.querySelector(".zc-close").addEventListener("click", closePopover);
    el.querySelector(".zc-back")?.addEventListener("click", () => {
      showStep1Popover(timeObj);
    });

    el.querySelector(".zc-generate-btn").addEventListener("click", () => {
      startDraftGeneration("suggest", timeObj, step2State.theirTz, step2State.yourTz, {
        hour: step2State.yourHour,
        minute: step2State.yourMinute,
        date: step2State.yourDate,
      }, el);
    });

    el.querySelector("#zc-reset-btn")?.addEventListener("click", () => {
      const restored = convertTime({ ...timeObj, timezone: theirTz }, yourTz);
      Object.assign(step2State, {
        theirHour: timeObj.hour,
        theirMinute: timeObj.minute || 0,
        theirDate: timeObj.date,
        yourHour: restored.hour,
        yourMinute: restored.minute,
        yourDate: restored.date,
        theirTz,
        yourTz,
      });
      refreshStep2(el);
    });

    bindScheduleTimelineDrag(el);

    positionPopover(el);
    requestAnimationFrame(() => {
      const da = el.querySelector("#zc-drag-area");
      if (da) updateStep2MarkerPositions(da, step2State);
    });
  }

  function buildStep2Html() {
    const s = step2State;

    return `
      <div class="zc-header">
        <div class="zc-header-nav">
          <button type="button" class="zc-back zc-text-btn" aria-label="Back">← Back</button>
        </div>
        <span class="zc-title">Zonecheck · Suggest another time</span>
        <div class="zc-header-actions">
          <button class="zc-close" aria-label="Close">×</button>
        </div>
      </div>
      <div class="zc-step2-body">
        ${buildTimelineDragHintHtml()}

        <section class="zc-section zc-section-hero">
        <div class="zc-step2-hero">
          <div class="zc-step2-hero-side">
            <div class="zc-step2-hero-rail zc-step2-hero-rail-left">
            ${theirNameFieldHtml()}
            ${buildStep2HeroTimeInputHtml("zc-their-large", "zc-step2-their-clock", s.theirHour, s.theirMinute, "Their time")}
            <div class="zc-step2-meta">
              <div class="zc-step2-date" id="zc-their-date">${formatDate(s.theirDate, s.theirTz)}</div>
              ${buildSourceBadgeHtml("detected")}
            </div>
            ${buildTimezoneSelectHtml("their", s.theirTz)}
            </div>
          </div>
          <div class="zc-step2-hero-side zc-step2-hero-right">
            <div class="zc-step2-hero-rail zc-step2-hero-rail-right">
            <div class="zc-step2-who zc-step2-who-right">You</div>
            ${buildStep2HeroTimeInputHtml("zc-your-large", "zc-step2-your-clock", s.yourHour, s.yourMinute, "Your time")}
            <div class="zc-step2-meta">
              <div class="zc-step2-date" id="zc-your-date">${formatDate(s.yourDate, s.yourTz)}</div>
              ${buildSourceBadgeHtml("settings")}
            </div>
            ${buildTimezoneSelectHtml("your", s.yourTz)}
            </div>
          </div>
        </div>
        </section>

        <section class="zc-section zc-section-timeline">
        ${buildScheduleTimelineHtml(s, true, { dragAreaId: "zc-drag-area" })}
        ${stepTimelineLegendHtml()}
        </section>

        <div class="zc-step2-hours-slot" id="zc-step2-hours-notice">${buildStep2HoursNoticeHtml(s)}</div>

        <div class="zc-step2-footer">
          <button class="zc-btn zc-btn-generate zc-generate-btn">Generate reply</button>
          <button class="zc-btn zc-btn-outline zc-btn-reset-soft zc-reset-btn" id="zc-reset-btn">Reset</button>
        </div>
      </div>`;
  }

  function buildInteractiveTimelineRow(date, tz, otherTz, markers, axisDateYmd, theirDateYmd) {
    return buildRailsTimelineDay(
      date,
      tz,
      markers,
      true,
      null,
      null,
      tz,
      otherTz || tz,
      axisDateYmd,
      theirDateYmd
    );
  }

  function refreshStep2(el, opts = {}) {
    const s = step2State;

    const theirLargeEl = el.querySelector("#zc-their-large");
    const yourLargeEl = el.querySelector("#zc-your-large");
    const theirDateEl = el.querySelector("#zc-their-date");
    const yourDateEl = el.querySelector("#zc-your-date");

    if (theirLargeEl && theirLargeEl !== document.activeElement) {
      theirLargeEl.value = formatHourClock12(s.theirHour, s.theirMinute);
    }
    if (yourLargeEl && yourLargeEl !== document.activeElement) {
      yourLargeEl.value = formatHourClock12(s.yourHour, s.yourMinute);
    }
    if (theirDateEl) theirDateEl.textContent = formatDate(s.theirDate, s.theirTz);
    if (yourDateEl) yourDateEl.textContent = formatDate(s.yourDate, s.yourTz);
    syncTimezoneSelects(el, s);

    const noticeSlot = el.querySelector("#zc-step2-hours-notice");
    if (noticeSlot) noticeSlot.innerHTML = buildStep2HoursNoticeHtml(s);

    const dragArea = el.querySelector("#zc-drag-area");
    if (!dragArea) return;

    if (opts.skipTimelineRebuild && dragState) {
      updateStep2MarkerPositions(dragArea, s);
      return;
    }

    dragArea.outerHTML = buildScheduleTimelineHtml(s, true, { dragAreaId: "zc-drag-area" });
    updateTheirNameLabels(el);
    const rebuilt = el.querySelector("#zc-drag-area");
    if (rebuilt) updateStep2MarkerPositions(rebuilt, s);
  }

  function scheduleStateForDraft(popoverEl) {
    if (popoverEl?.classList?.contains("zc-popover-step1")) return step1State;
    if (popoverEl?.classList?.contains("zc-popover-step2")) return step2State;
    if (popoverEl?.classList?.contains("zc-popover-step3")) return lastDraftScheduleState || step1State;
    return step2State;
  }

  // ─── Draft generation ─────────────────────────────────────────────────────

  function startDraftGeneration(type, timeObj, theirTz, yourTz, yourConverted, popoverEl) {
    syncTheirNameFromInput(popoverEl);
    const body = popoverEl.querySelector(".zc-step2-body");
    if (body) {
      body.innerHTML = `<div class="zc-loading"><div class="zc-spinner"></div><span>Generating reply…</span></div>`;
    }

    const s = scheduleStateForDraft(popoverEl);
    chrome.storage.local.get(["user_reply_name"], (r) => {
      const userReplyName = typeof r.user_reply_name === "string" ? r.user_reply_name.trim() : "";
      const context = {
        type,
        senderName: theirNameLabel(),
        userReplyName,
        originalTime: `${formatHour(s.theirHour ?? timeObj.hour, (s.theirMinute ?? timeObj.minute) || 0)}`,
        theirTz: theirTzUiLabel(theirTz, s.theirDate || timeObj.date, {
          persistedEmailLabel: type === "suggest" ? s.theirTzEmailLabel : null,
          rawTimeObjTimezone: timeObj.timezone,
        }),
        yourTime: `${formatHour(yourConverted.hour, yourConverted.minute || 0)}`,
        yourTz: tzAbbr(yourTz, type === "suggest" ? s.yourDate : yourConverted.date),
        suggestedTimeTheirs: type === "suggest"
          ? `${formatHour(s.theirHour, s.theirMinute)} on ${formatDate(s.theirDate, theirTz)}`
          : "",
        suggestedTimeYours: type === "suggest"
          ? `${formatHour(s.yourHour, s.yourMinute)} on ${formatDate(s.yourDate, yourTz)}`
          : "",
      };

      sendToBackground({ type: "GENERATE_DRAFT", context }, (response) => {
        if (!response || !response.success) {
          showInlineError(popoverEl, response?.error || "Failed to generate draft.");
          return;
        }
        draftData = response.drafts;
        showStep3Popover(timeObj, theirTz, yourTz, yourConverted, type, s);
      });
    });
  }

  function showInlineError(popoverEl, msg) {
    const body =
      popoverEl.querySelector(".zc-step2-body") ||
      popoverEl.querySelector(".zc-step3-body");
    if (body) {
      body.innerHTML = `<div class="zc-error-body"><span class="zc-status-pill zc-pill-red">${escHtml(msg)}</span></div>`;
    }
  }

  // ─── Step 3 — Reply draft ─────────────────────────────────────────────────

  function sizeDraftTextarea(textarea) {
    if (!textarea || !textarea.isConnected) return;
    textarea.style.height = "0px";
    textarea.style.overflowY = "hidden";
    const cap = Math.max(220, Math.floor(window.innerHeight * 0.72));
    textarea.style.maxHeight = `${cap}px`;
    const sh = textarea.scrollHeight;
    const minH = 96;
    const target = Math.min(Math.max(sh, minH), cap);
    textarea.style.height = `${target}px`;
    textarea.style.overflowY = sh > cap ? "auto" : "hidden";
  }

  function showStep3Popover(timeObj, theirTz, yourTz, yourConverted, action, suggestState) {
    let currentTone = "warm";

    lastDraftScheduleState = suggestState;

    const el = document.createElement("div");
    el.className = "zc-popover zc-popover-step3";
    replaceActivePopover(el);

    const summaryLine = buildSummaryLine(action, timeObj, theirTz, yourTz, yourConverted, suggestState);

    const render = () => {
      el.innerHTML = `
        <div class="zc-header">
          <div class="zc-header-nav">
            <button type="button" class="zc-back zc-text-btn" aria-label="Back">← Back</button>
          </div>
          <span class="zc-title">Reply draft</span>
          <div class="zc-header-actions">
            <button class="zc-close" aria-label="Close">×</button>
          </div>
        </div>
        <div class="zc-step3-body">
          <div class="zc-summary-line">${escHtml(summaryLine)}</div>
          <div class="zc-tone-row">
            ${["formal", "warm", "brief"].map((t) =>
              `<button class="zc-tone-btn ${t === currentTone ? "zc-tone-active" : ""}" data-tone="${t}">${t.charAt(0).toUpperCase() + t.slice(1)}</button>`
            ).join("")}
          </div>
          <textarea class="zc-draft-textarea" id="zc-draft-text">${escHtml(draftData[currentTone] || "")}</textarea>
          <div class="zc-step3-actions">
            <button class="zc-btn zc-btn-blue" id="zc-insert-btn">Insert into Gmail</button>
            <button class="zc-btn zc-btn-outline" id="zc-copy-btn">Copy</button>
            <button class="zc-btn zc-btn-outline" id="zc-redo-btn">↺ Redo</button>
          </div>
          <div class="zc-confirm-toast-wrap" aria-live="polite">
            <div class="zc-confirm-toast" id="zc-confirm-bar" hidden>
              <span class="zc-confirm-toast-icon" aria-hidden="true">✓</span>
              <span class="zc-confirm-toast-text"></span>
            </div>
          </div>
        </div>`;

      el.querySelector(".zc-close").addEventListener("click", closePopover);
      el.querySelector(".zc-back")?.addEventListener("click", () => {
        if (action === "suggest") showStep2Popover(timeObj, theirTz, yourTz);
        else showStep1Popover(timeObj);
      });

      el.querySelectorAll(".zc-tone-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          rememberPopoverViewportPosition(el);
          currentTone = btn.dataset.tone;
          render();
        });
      });

      el.querySelector("#zc-insert-btn").addEventListener("click", () => {
        const text = el.querySelector("#zc-draft-text").value;
        insertIntoGmail(text);
        showConfirm(el, "Inserted into Gmail compose");
      });

      el.querySelector("#zc-copy-btn").addEventListener("click", () => {
        const text = el.querySelector("#zc-draft-text").value;
        navigator.clipboard.writeText(text).then(() => showConfirm(el, "Copied to clipboard"));
      });

      el.querySelector("#zc-redo-btn").addEventListener("click", () => {
        const body = el.querySelector(".zc-step3-body");
        body.innerHTML = `<div class="zc-loading"><div class="zc-spinner"></div><span>Regenerating…</span></div>`;
        startDraftGeneration(action, timeObj, theirTz, yourTz, yourConverted, el);
      });

      const ta = el.querySelector("#zc-draft-text");
      ta.addEventListener("input", () => {
        sizeDraftTextarea(ta);
        positionPopover(el);
      });
      requestAnimationFrame(() => {
        sizeDraftTextarea(ta);
        positionPopover(el);
        requestAnimationFrame(() => {
          sizeDraftTextarea(ta);
          positionPopover(el);
        });
      });
    };

    render();
    positionPopover(el);
  }

  function buildSummaryLine(action, timeObj, theirTz, yourTz, yourConverted, s) {
    const th = s?.theirHour ?? timeObj.hour;
    const tm = s?.theirMinute ?? timeObj.minute ?? 0;
    const td = s?.theirDate ?? timeObj.date;
    const yh = s?.yourHour ?? yourConverted.hour;
    const ym = s?.yourMinute ?? yourConverted.minute ?? 0;
    const yd = s?.yourDate ?? yourConverted.date;
    if (action === "yes") {
      return `Confirming ${formatHour(th, tm)} ${theirTzUiLabel(theirTz, td, {
        rawTimeObjTimezone: timeObj.timezone,
      })} — that's ${formatHour(yh, ym)} ${tzAbbr(yourTz, yd)} for you`;
    }
    if (action === "no") {
      return `Declining ${formatHour(th, tm)} ${theirTzUiLabel(theirTz, td, {
        rawTimeObjTimezone: timeObj.timezone,
      })}`;
    }
    return `Suggesting ${formatDate(s.theirDate, theirTz)} · ${formatHour(s.theirHour, s.theirMinute)} ${theirTzUiLabel(theirTz, s.theirDate, {
      persistedEmailLabel: s.theirTzEmailLabel,
      rawTimeObjTimezone: timeObj?.timezone,
    })} — that's ${formatHour(s.yourHour, s.yourMinute)} ${tzAbbr(yourTz, s.yourDate)} for you`;
  }

  function showConfirm(el, msg) {
    const bar = el.querySelector("#zc-confirm-bar");
    if (!bar) return;
    const textEl = bar.querySelector(".zc-confirm-toast-text");
    if (textEl) textEl.textContent = msg;

    if (bar._zcDismissT) clearTimeout(bar._zcDismissT);
    if (bar._zcHideT) clearTimeout(bar._zcHideT);

    bar.removeAttribute("hidden");
    requestAnimationFrame(() => {
      bar.classList.add("zc-confirm-toast--visible");
    });

    bar._zcDismissT = setTimeout(() => {
      bar.classList.remove("zc-confirm-toast--visible");
      bar._zcHideT = setTimeout(() => {
        bar.setAttribute("hidden", "");
        bar._zcHideT = null;
      }, 220);
      bar._zcDismissT = null;
    }, 2000);
  }

  /**
   * Gmail compose uses <div> blocks (and <div><br></div> for blank lines), not a single text node.
   * Mirrors line breaks from the draft textarea so the compose body matches the modal preview.
   */
  function buildGmailComposeBodyFragment(text) {
    const raw = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = raw.split("\n");
    const frag = document.createDocumentFragment();
    let lastNode = null;
    for (const line of lines) {
      const div = document.createElement("div");
      if (line.length === 0) {
        div.appendChild(document.createElement("br"));
      } else {
        div.textContent = line;
      }
      frag.appendChild(div);
      lastNode = div;
    }
    return { frag, lastNode };
  }

  function insertIntoGmail(text) {
    const compose = document.querySelector(".Am.Al.editable[contenteditable='true']")
      || document.querySelector("[role='textbox'][aria-label*='Message Body']")
      || document.querySelector(".editable[contenteditable='true']");

    if (compose) {
      compose.focus();
      const { frag, lastNode } = buildGmailComposeBodyFragment(text);
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && compose.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(frag);
        if (lastNode && compose.contains(lastNode)) {
          range.setStartAfter(lastNode);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } else {
        const range = document.createRange();
        range.selectNodeContents(compose);
        range.collapse(false);
        range.insertNode(frag);
        if (lastNode && compose.contains(lastNode)) {
          range.setStartAfter(lastNode);
          range.collapse(true);
          const s = window.getSelection();
          if (s) {
            s.removeAllRanges();
            s.addRange(range);
          }
        }
      }
      compose.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      navigator.clipboard.writeText(text);
    }
  }

  // ─── Close popover ────────────────────────────────────────────────────────

  function closePopover() {
    closeTzPicker();
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
    removePill();
    activeRange = null;
    selectionAnchorRect = null;
    dragState = null;
    popoverDragState = null;
    popoverViewportPosition = null;
  }

  // ─── Timezone resolution ──────────────────────────────────────────────────

  const TZ_MAP = {
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
    CST_CN: "Asia/Shanghai",
    AEST: "Australia/Sydney",
    AEDT: "Australia/Sydney",
    NZST: "Pacific/Auckland",
    NZDT: "Pacific/Auckland",
    HST: "Pacific/Honolulu",
    AKST: "America/Anchorage",
    AKDT: "America/Anchorage",
  };

  function resolveIanaTz(abbr) {
    if (!abbr) return userTimezone;
    if (abbr.includes("/")) return abbr;
    return TZ_MAP[abbr.toUpperCase()] || userTimezone;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }

  console.log("[Zonecheck] Content script loaded on", window.location.hostname);
})();
