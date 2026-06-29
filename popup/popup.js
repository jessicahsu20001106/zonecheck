const HOURS = Array.from({ length: 24 }, (_, i) => {
  const ampm = i < 12 ? "am" : "pm";
  const h = i === 0 ? 12 : i > 12 ? i - 12 : i;
  return [i, `${h}:00 ${ampm}`];
});

function populateSelect(id, options, selected) {
  const el = document.getElementById(id);
  el.innerHTML = "";
  for (const [val, label] of options) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    if (val === selected || String(val) === String(selected)) opt.selected = true;
    el.appendChild(opt);
  }
}

function getSettingsTimezoneIana() {
  const wrap = document.querySelector("#timezonePickerMount .zc-tz-picker");
  return wrap?.dataset?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function mountSettingsTimezonePicker(ianaTz) {
  const ZT = globalThis.ZC_TIMEZONE;
  const host = document.getElementById("timezonePickerMount");
  if (!ZT || !host) return;

  // Close any open picker and clear stale wrap reference before replacing DOM.
  ZT.closeTzPicker();

  const alreadyBound = host.dataset.zcTzPickerBound === "1";
  host.innerHTML = ZT.buildTimezoneSelectHtml("your", ianaTz);

  // bindTimezoneSelects must run only once per host: each call adds new listeners.
  // mount runs twice (initial + storage); duplicate toggles open then immediately close.
  if (!alreadyBound) {
    ZT.bindTimezoneSelects(host, (_wrap, _which, newTz) => {
      const hint = document.getElementById("tzDetected");
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (hint) {
        hint.textContent =
          newTz === detected
            ? `Matches browser: ${ZT.tzOutlookListLabel(newTz)}`
            : `Selected: ${ZT.tzOutlookListLabel(newTz)}`;
      }
    });
  }
}

function showStatus(msg, isError) {
  const el = document.getElementById("statusMsg");
  el.textContent = msg;
  el.className = `zc-settings-status ${isError ? "zc-settings-status-err" : "zc-settings-status-ok"}`;
  el.style.display = "block";
  setTimeout(() => {
    el.style.display = "none";
  }, 3000);
}

document.addEventListener("DOMContentLoaded", () => {
  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ZT = globalThis.ZC_TIMEZONE;

  populateSelect("bhStart", HOURS, 9);
  populateSelect("bhEnd", HOURS, 18);

  if (!ZT) {
    const host = document.getElementById("timezonePickerMount");
    if (host) {
      host.innerHTML =
        '<p class="zc-settings-hint" style="color:var(--zc-red)">Timezone UI failed to load. Reinstall the extension or reload it.</p>';
    }
  } else {
    mountSettingsTimezonePicker(detectedTz);
  }

  chrome.storage.local.get(
    ["user_timezone", "business_hours", "user_reply_name"],
    (result) => {
      const nameEl = document.getElementById("userReplyName");
      if (nameEl && typeof result.user_reply_name === "string") {
        nameEl.value = result.user_reply_name;
      }

      const savedTz = result.user_timezone || detectedTz;
      if (ZT) {
        mountSettingsTimezonePicker(savedTz);
      }

      if (result.business_hours) {
        document.getElementById("bhStart").value = result.business_hours.start;
        document.getElementById("bhEnd").value = result.business_hours.end;
      }

      const tzHint = document.getElementById("tzDetected");
      if (tzHint && ZT) {
        tzHint.textContent = result.user_timezone
          ? `Saved: ${ZT.tzOutlookListLabel(result.user_timezone)}`
          : `Auto-detected: ${ZT.tzOutlookListLabel(detectedTz)}`;
      }
    }
  );

  document.getElementById("saveBtn").addEventListener("click", () => {
    const timezone = getSettingsTimezoneIana();
    const bhStart = parseInt(document.getElementById("bhStart").value, 10);
    const bhEnd = parseInt(document.getElementById("bhEnd").value, 10);

    if (bhEnd <= bhStart) {
      showStatus("End time must be after start time", true);
      return;
    }

    const data = {
      user_timezone: timezone,
      business_hours: { start: bhStart, end: bhEnd },
      user_reply_name: document.getElementById("userReplyName")?.value.trim() || "",
    };

    chrome.storage.local.set(data, () => {
      showStatus("Settings saved ✓", false);
      const tzHint = document.getElementById("tzDetected");
      if (tzHint && globalThis.ZC_TIMEZONE) {
        tzHint.textContent = `Saved: ${globalThis.ZC_TIMEZONE.tzOutlookListLabel(timezone)}`;
      }
    });
  });
});
