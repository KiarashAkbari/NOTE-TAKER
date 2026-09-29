/* ==========================================================================
   PERSONAL OS — ai.js  (v2)

   Free, offline+online AI task generation. No backend, no paid API, no API
   key, no npm, no CDN. Vendored plain JS, lazy-loaded like GSI.

   Two execution paths (both free):
     1. Heuristic date/entity parser — always available, works 100% offline.
     2. Built-in browser AI if present (window.ai / LanguageModel) — optional
        progressive enhancement; falls back to heuristic immediately if absent
        or if it would require a network/key.

   This file is NOT loaded unless pos-ai-enabled is ON and the user submits
   text. The toggle off means zero loads/requests/DOM — see index.html.

   Public API: window.PersonalOS_AI = { parse(text, ctx), generate(text, ctx) }
   ctx = { tags: [{id,name}], now: Date.now() }

   Output is an array of items:
     { title, body, tagIds:[], alarmAt:number|null, alarmLabel, kind:'task'|'note' }

   All timestamps are local wall-clock epochs (like readAlarmFromFields).
   Caller is responsible for feeding results through commit() and
   KNOWN_ITEM_FIELDS — this file creates no state and holds none.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------- tag matching ---------- */
  function matchTagIds(snippet, tags) {
    if (!snippet || !tags || !tags.length) return [];
    const low = snippet.toLowerCase();
    const out = [];
    tags.forEach(function (t) {
      if (!t || !t.name) return;
      if (low.indexOf(t.name.toLowerCase()) !== -1) out.push(t.id);
      else {
        // Also match #tag syntax
        if (low.indexOf('#' + t.name.toLowerCase()) !== -1 && out.indexOf(t.id) === -1) out.push(t.id);
      }
    });
    return out;
  }

  /* ---------- date parsing ---------- */
  var MONTHS = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11
  };
  var WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

  function nextWeekday(from, targetDay) {
    var d = new Date(from);
    var diff = (targetDay - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7; // next occurrence, not today
    d.setDate(d.getDate() + diff);
    return d;
  }

  function parseTimeSnippet(snippet) {
    // Returns { h, m } or null. Matches: at 3pm, at 3:30 pm, 14:00, 9am, 3 pm, at 9, etc.
    // Prefer "at X" but also bare time
    var re = /(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i;
    var m = snippet.match(re);
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var min = m[2] ? parseInt(m[2], 10) : 0;
    var ap = m[3] ? m[3].toLowerCase().replace(/\./g, '') : '';
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    // Without am/pm, treat 1-7 as pm if no context? Heuristic: keep as-is (user likely means 24h)
    // But if h is 1-12 without am/pm and snippet has no am/pm, assume local 9am-ish? Keep h.
    if (h > 23 || min > 59) return null;
    return { h: h, m: min, raw: m[0] };
  }

  function extractDateTime(snippet, nowTs) {
    var now = new Date(nowTs);
    var low = snippet.toLowerCase();
    var base = null;
    var hasTime = false;
    var timeInfo = null;

    // Try to find a time first for later combining
    // Look for specific time expression
    var atTimeRe = /at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b/i;
    var timeMatch = snippet.match(atTimeRe);
    if (timeMatch) {
      timeInfo = parseTimeSnippet(timeMatch[0]);
      if (timeInfo) hasTime = true;
    }

    // Absolute date: YYYY-MM-DD or MM/DD/YYYY or DD-MM-YYYY
    var isoRe = /(\d{4})-(\d{1,2})-(\d{1,2})/;
    var mIso = snippet.match(isoRe);
    if (mIso) {
      var y = parseInt(mIso[1], 10);
      var mo = parseInt(mIso[2], 10) - 1;
      var d = parseInt(mIso[3], 10);
      base = new Date(y, mo, d);
      if (!isNaN(base.getTime())) {
        if (hasTime) { base.setHours(timeInfo.h, timeInfo.m, 0, 0); }
        else { base.setHours(9, 0, 0, 0); }
        if (base.getTime() > nowTs) return base.getTime();
        // If past, still return (user may mean past due -> fire soon) but nudge to future
        // For past time today, move to tomorrow
        if (base.getTime() <= nowTs && snippet.toLowerCase().indexOf('today') !== -1 && hasTime) {
          base.setDate(base.getDate() + 1);
          return base.getTime();
        }
        return base.getTime();
      }
    }

    // Slash date
    var slashRe = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/;
    var mSlash = snippet.match(slashRe);
    if (mSlash) {
      var a = parseInt(mSlash[1], 10);
      var b = parseInt(mSlash[2], 10);
      var yr = mSlash[3] ? parseInt(mSlash[3], 10) : now.getFullYear();
      if (yr < 100) yr += 2000;
      // Assume MM/DD
      var baseSlash = new Date(yr, a - 1, b);
      if (!isNaN(baseSlash.getTime())) {
        if (hasTime) baseSlash.setHours(timeInfo.h, timeInfo.m, 0, 0);
        else baseSlash.setHours(9, 0, 0, 0);
        if (baseSlash.getTime() > nowTs - 86400000) return baseSlash.getTime();
      }
    }

    // Month name date: "Jan 15", "15 January", "jan 15 at 3pm"
    var monthRe = new RegExp('\\b(' + Object.keys(MONTHS).join('|') + ')\\b\\s*(\\d{1,2})?|\\b(\\d{1,2})\\s+(' + Object.keys(MONTHS).join('|') + ')\\b', 'i');
    var mMonth = snippet.match(monthRe);
    if (mMonth) {
      var monName, dayNum;
      if (mMonth[1]) { monName = mMonth[1].toLowerCase(); dayNum = mMonth[2] ? parseInt(mMonth[2], 10) : 1; }
      else { dayNum = parseInt(mMonth[3], 10); monName = mMonth[4].toLowerCase(); }
      var mv = MONTHS[monName];
      var baseMonth = new Date(now.getFullYear(), mv, dayNum);
      if (hasTime) baseMonth.setHours(timeInfo.h, timeInfo.m, 0, 0);
      else baseMonth.setHours(9, 0, 0, 0);
      if (baseMonth.getTime() < nowTs) baseMonth.setFullYear(baseMonth.getFullYear() + 1);
      return baseMonth.getTime();
    }

    // Weekday: "monday", "next friday", "on tuesday"
    var wdRe = /\b(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/i;
    var mWd = low.match(wdRe);
    if (mWd) {
      var wdName = mWd[1].toLowerCase();
      var target = WEEKDAYS[wdName];
      var baseWd = nextWeekday(now, target);
      if (hasTime) baseWd.setHours(timeInfo.h, timeInfo.m, 0, 0);
      else baseWd.setHours(9, 0, 0, 0);
      return baseWd.getTime();
    }

    // Relative: tomorrow, today, next week, next month, in X days/hours/minutes, in a week, in an hour
    if (/\btomorrow\b/i.test(low)) {
      var dTom = new Date(now);
      dTom.setDate(dTom.getDate() + 1);
      if (hasTime) dTom.setHours(timeInfo.h, timeInfo.m, 0, 0);
      else dTom.setHours(9, 0, 0, 0);
      return dTom.getTime();
    }
    if (/\btoday\b/i.test(low)) {
      var dToday = new Date(now);
      if (hasTime) {
        dToday.setHours(timeInfo.h, timeInfo.m, 0, 0);
        if (dToday.getTime() <= nowTs) dToday.setDate(dToday.getDate() + 1);
      } else {
        dToday.setHours(dToday.getHours() + 1, 0, 0, 0);
      }
      return dToday.getTime();
    }
    if (/\bnext week\b/i.test(low)) {
      var dW = new Date(now);
      dW.setDate(dW.getDate() + 7);
      dW.setHours(hasTime ? timeInfo.h : 9, hasTime ? timeInfo.m : 0, 0, 0);
      return dW.getTime();
    }
    if (/\bnext month\b/i.test(low)) {
      var dM = new Date(now);
      dM.setMonth(dM.getMonth() + 1);
      dM.setHours(hasTime ? timeInfo.h : 9, hasTime ? timeInfo.m : 0, 0, 0);
      return dM.getTime();
    }
    // in X days/hours/minutes/weeks
    var inRe = /in\s+(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks|month|months)\b/i;
    var mIn = low.match(inRe);
    if (mIn) {
      var n = parseInt(mIn[1], 10);
      var unit = mIn[2].toLowerCase();
      var dIn = new Date(now);
      if (unit.indexOf('min') === 0) dIn.setMinutes(dIn.getMinutes() + n);
      else if (unit.indexOf('hour') === 0 || unit === 'hr' || unit === 'hrs') dIn.setHours(dIn.getHours() + n);
      else if (unit.indexOf('day') === 0) dIn.setDate(dIn.getDate() + n);
      else if (unit.indexOf('week') === 0) dIn.setDate(dIn.getDate() + n * 7);
      else if (unit.indexOf('month') === 0) dIn.setMonth(dIn.getMonth() + n);
      // If also has specific time, override time part
      if (hasTime) dIn.setHours(timeInfo.h, timeInfo.m, 0, 0);
      return dIn.getTime();
    }
    if (/\bin an hour\b/i.test(low) || /\bin a hour\b/i.test(low)) {
      var dHr = new Date(now);
      dHr.setHours(dHr.getHours() + 1, 0, 0, 0);
      return dHr.getTime();
    }
    if (/\bin a day\b/i.test(low)) {
      var dDay = new Date(now);
      dDay.setDate(dDay.getDate() + 1);
      dDay.setHours(9, 0, 0, 0);
      return dDay.getTime();
    }

    // Bare time without date -> today or tomorrow
    if (hasTime && !base) {
      // If snippet has a bare time like "at 3pm" without date words, treat as today/tomorrow
      // Check if snippet is mostly time-related or short; assume next occurrence
      var dBare = new Date(now);
      dBare.setHours(timeInfo.h, timeInfo.m, 0, 0);
      if (dBare.getTime() <= nowTs) dBare.setDate(dBare.getDate() + 1);
      // Only use bare time if snippet is not empty after removing time phrase? Heuristic: use it.
      // Require explicit "at" or am/pm or colon to avoid false positives on numbers
      if (/(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(snippet) || /\bat\s+\d/i.test(low) || /\d:\d/.test(snippet)) {
        return dBare.getTime();
      }
    }

    // "tonight", "this evening", "this afternoon" -> today evening
    if (/\btonight\b/i.test(low)) {
      var dNight = new Date(now);
      dNight.setHours(20, 0, 0, 0);
      if (dNight.getTime() <= nowTs) dNight.setDate(dNight.getDate() + 1);
      return dNight.getTime();
    }
    if (/\bthis evening\b/i.test(low)) {
      var dEve = new Date(now);
      dEve.setHours(18, 0, 0, 0);
      if (dEve.getTime() <= nowTs) dEve.setDate(dEve.getDate() + 1);
      return dEve.getTime();
    }

    return null;
  }

  /* ---------- splitter ---------- */
  function splitTasks(raw) {
    if (!raw) return [];
    var text = String(raw).trim();
    if (!text) return [];

    // Normalize bullets and numbers
    // Split on: newlines, semicolons, " then ", " and then "
    var lines = text.split(/\r?\n/);
    var parts = [];
    lines.forEach(function (line) {
      // Split by semicolon or " • " etc but keep max length
      var sub = line.split(/\s*;\s*/);
      sub.forEach(function (s) {
        s = s.trim();
        if (!s) return;
        // Split " and " if it looks like task separator and both sides are imperative
        // Heuristic: if " and " appears and each side has >10 chars, split
        // Simpler: split on " and " only when there are commas? Keep simple: don't split "and"
        parts.push(s);
      });
    });

    // If only one part but it contains "1. " or "- " patterns within the same line (user pasted without newlines)
    // Try to split on bullet separators
    if (parts.length === 1) {
      var single = parts[0];
      // Detect numbered list: "1. Buy milk 2. Call mom"
      var numSplit = single.split(/\s*\d+[\.\)]\s+/);
      if (numSplit.length > 2) {
        // First element before 1. is empty
        parts = numSplit.filter(function (p) { return p.trim(); });
      } else {
        // Detect dash bullets
        var dashSplit = single.split(/\s+[-•]\s+/);
        if (dashSplit.length > 2) parts = dashSplit.filter(function (p) { return p.trim(); });
        else {
          // Detect comma-separated if many commas and each looks like task
          var commaParts = single.split(/\s*,\s+/);
          if (commaParts.length > 2 && commaParts.every(function (p) { return p.length > 8; })) {
            parts = commaParts;
          }
        }
      }
    }

    // Final: if still one, try to split on " and " when it clearly separates two verbs
    if (parts.length === 1 && parts[0].length > 80) {
      // Longer single paragraph — split on period
      var sentSplit = parts[0].split(/\.\s+/);
      if (sentSplit.length > 1) {
        parts = sentSplit.map(function (p) { return p.trim().replace(/\.$/, ''); }).filter(Boolean);
      }
    }

    return parts.map(function (p) { return p.replace(/^[-•\d\.\)\s]+/, '').trim(); }).filter(Boolean);
  }

  function cleanTitle(raw) {
    var t = String(raw).trim();
    // Remove leading verbs like "task:" "note:" "todo"
    t = t.replace(/^(task|todo|note|reminder)\s*[:\-]\s*/i, '');
    // Remove trailing date/time artifacts already captured? Keep for now but shorten
    // Truncate at ~80 chars for title
    if (t.length > 80) {
      var cut = t.slice(0, 80);
      var lastSpace = cut.lastIndexOf(' ');
      if (lastSpace > 50) cut = cut.slice(0, lastSpace);
      t = cut + '…';
    }
    // Capitalize first letter
    if (t) t = t.charAt(0).toUpperCase() + t.slice(1);
    return t || 'UNTITLED';
  }

  function guessKind(snippet) {
    var low = snippet.toLowerCase();
    // Notes are more descriptive; tasks are actionable.
    // Heuristic: if starts with verb or contains "buy", "call", "send", "finish", etc -> task
    // Otherwise if contains long body or "idea", "thought", "remember" -> note
    var taskHints = /\b(buy|call|send|email|finish|complete|do|create|make|write|prepare|schedule|meeting|appointment|pay|book|clean|fix|update|review|submit)\b/i;
    if (taskHints.test(low)) return 'task';
    if (low.length > 140) return 'note';
    // Default to task — more useful with alarm/calendar
    return 'task';
  }

  /* ---------- main parse ---------- */
  function parse(text, ctx) {
    ctx = ctx || {};
    var tags = ctx.tags || [];
    var now = ctx.now || Date.now();
    var raw = String(text || '').trim();
    if (!raw) return [];

    var chunks = splitTasks(raw);
    if (!chunks.length) chunks = [raw];

    var results = [];
    chunks.forEach(function (chunk) {
      var alarmAt = extractDateTime(chunk, now);
      var tagIds = matchTagIds(chunk, tags);
      var kind = guessKind(chunk);

      // Build title: remove date phrase from title for cleaner look but keep body intact
      // For title, strip the matched date/time phrase if it made alarmAt
      var titleSrc = chunk;
      // If alarm detected, we still want the alarmLabel to reflect the chunk's intent
      var alarmLabel = '';
      if (alarmAt) {
        // Use chunk up to 40 chars as label if title long
        var labelSrc = chunk.replace(/\s+/g, ' ').trim();
        if (labelSrc.length > 40) labelSrc = labelSrc.slice(0, 40).trim() + '…';
        alarmLabel = labelSrc;
      }

      var title = cleanTitle(titleSrc);
      // Body is the full chunk unless it's short and title already covers it
      var body = chunk;
      if (body.length < 10) body = '';
      // If body equals title, leave body empty to avoid duplication
      if (body && title && body.toLowerCase() === title.toLowerCase()) body = '';
      if (body && title && body.length <= title.length + 5) {
        // If chunk is short, keep title only, body empty
        if (chunk.length < 60) body = '';
      }

      results.push({
        title: title,
        body: body,
        tagIds: tagIds,
        alarmAt: alarmAt,
        alarmLabel: alarmLabel,
        kind: kind,
        source: chunk
      });
    });

    return results;
  }

  /* ---------- optional browser AI hook (free, no key) ---------- */
  // If window.ai / LanguageModel is present (Chrome built-in), we could use it,
  // but heuristic is reliable offline and avoids permission prompts.
  // We keep the hook dormant: caller may optionally try window.ai first and fall
  // back to parse() on failure — AI is enhancement, not requirement.

  window.PersonalOS_AI = {
    parse: parse,
    version: 1,
    // also expose helpers for testing
    _splitTasks: splitTasks,
    _extractDateTime: extractDateTime,
    _matchTagIds: matchTagIds
  };

})();
