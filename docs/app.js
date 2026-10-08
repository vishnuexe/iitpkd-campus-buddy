/* IITPKD Campus Buddy — web app logic.
   Ports the Android app's schedule maths (BusSchedule.kt) and holiday handling
   (AcademicCalendar.kt) to the browser and renders the next-bus cards,
   per-direction timelines, upcoming holidays, full timetable and the academic
   calendar and the mess menu. Fully offline: all data comes from
   window.SCHEDULE (schedule.js), window.CALENDAR (calendar.js) and window.MESS (mess.js). */
(function () {
  "use strict";

  // ---- installability (Add to Home Screen / desktop install) ---------------
  var deferredPrompt = null;
  function isStandalone() {
    return ["standalone", "minimal-ui", "fullscreen", "window-controls-overlay"].some(function (mode) {
      return window.matchMedia("(display-mode: " + mode + ")").matches;
    }) || window.navigator.standalone === true;
  }
  // Browsers can keep offering to install (or keep the page open) after the app
  // is installed, so installation is also remembered here: once installed —
  // or once opened as an installed app — the bar never comes back.
  function markInstalled() {
    try { localStorage.setItem("installed", "1"); } catch (e) {}
    deferredPrompt = null;
    var bar = document.getElementById("installbar");
    if (bar) bar.hidden = true;
  }
  function knownInstalled() {
    return isStandalone() || localStorage.getItem("installed") === "1";
  }
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    if (knownInstalled()) return;
    deferredPrompt = e;
    var show = function () {
      var bar = document.getElementById("installbar");
      if (bar && deferredPrompt && !knownInstalled()) bar.hidden = false;
    };
    // Where supported, ask the browser whether this web app is already installed.
    if (navigator.getInstalledRelatedApps) {
      navigator.getInstalledRelatedApps().then(function (apps) {
        if (apps && apps.length) markInstalled(); else show();
      }).catch(show);
    } else show();
  });
  window.addEventListener("appinstalled", markInstalled);
  function initInstall() {
    if (isStandalone()) markInstalled();
    // ✕ hides the bar for good, whatever the browser thinks about installation.
    document.getElementById("install-close").addEventListener("click", markInstalled);
    var btn = document.getElementById("install");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function (choice) {
        if (choice && choice.outcome === "accepted") markInstalled();
        deferredPrompt = null;
        document.getElementById("installbar").hidden = true;
      });
    });
  }

  var CUTOVER_HOUR = 4; // buses run past midnight; <4am belongs to previous service day
  var DIRS = [
    { id: "NILA_TO_SAHYADRI", key: "nilaToSahyadri", label: "Nila → Sahyadri" },
    { id: "SAHYADRI_TO_NILA", key: "sahyadriToNila", label: "Sahyadri → Nila" },
  ];
  var DAY_LABEL = { working: "Working day", saturday: "Saturday / holiday", sunday: "Sunday" };
  var KIND = {
    PALAKKAD_TOWN: { name: "Palakkad Town", short: "Town" },
    WISE_PARK: { name: "Wise Park Junction", short: "Wise Park" },
  };
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December"];

  // ---- dates ----------------------------------------------------------------
  // "Now", overridable with ?now=2026-12-25T10:00 to preview a holiday or any other day.
  var NOW_OVERRIDE = (function () {
    var m = /[?&]now=([^&]+)/.exec(location.search);
    var d = m ? new Date(decodeURIComponent(m[1])) : null;
    return d && !isNaN(d) ? d : null;
  })();
  function currentTime() { return NOW_OVERRIDE ? new Date(NOW_OVERRIDE.getTime()) : new Date(); }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function fromIso(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  /** The service day `d` belongs to: the small hours still count as the previous calendar day. */
  function serviceDay(d) {
    var s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (d.getHours() < CUTOVER_HOUR) s.setDate(s.getDate() - 1);
    return s;
  }
  function daysBetween(fromIsoStr, toIsoStr) {
    return Math.round((fromIso(toIsoStr) - fromIso(fromIsoStr)) / 86400000);
  }
  function shortDate(isoStr, withYear) {
    var d = fromIso(isoStr);
    return d.getDate() + " " + MONTHS[d.getMonth()] + (withYear ? " " + d.getFullYear() : "");
  }
  function weekdayDate(isoStr) { return WEEKDAYS[fromIso(isoStr).getDay()] + " " + shortDate(isoStr); }

  // ---- holidays -------------------------------------------------------------
  var HOLIDAYS = window.CALENDAR.holidays;
  var HOLIDAY_BY_DATE = {};
  HOLIDAYS.forEach(function (h) { HOLIDAY_BY_DATE[h.date] = h; });
  function holidayOn(isoStr) { return HOLIDAY_BY_DATE[isoStr] || null; }
  /** The gazetted holiday being celebrated today (by calendar date), if any. */
  function todaysHoliday(now) { return holidayOn(iso(now)); }
  function daysLeftLabel(todayIso, dateIso) {
    var n = daysBetween(todayIso, dateIso);
    return n === 0 ? "Today" : n === 1 ? "Tomorrow" : n + " days";
  }

  // ---- schedule maths -------------------------------------------------------
  function serviceMinutes(hhmm) {
    var p = hhmm.split(":"), h = +p[0], m = +p[1];
    var min = h * 60 + m;
    return h < CUTOVER_HOUR ? min + 24 * 60 : min;
  }
  function nowServiceMinutes(d) {
    var h = d.getHours(), m = d.getMinutes();
    var min = h * 60 + m;
    return h < CUTOVER_HOUR ? min + 24 * 60 : min;
  }
  /** Weekday gazetted holidays run the Saturday/holiday service automatically;
      `holidayOverride` is the manual "holiday today" switch for anything else. */
  function currentDayType(holidayOverride, d) {
    if (holidayOverride) return "saturday";
    var sd = serviceDay(d), day = sd.getDay(); // 0 Sun .. 6 Sat
    if (day === 0) return "sunday";
    if (day === 6) return "saturday";
    return holidayOn(iso(sd)) ? "saturday" : "working";
  }
  function times(dirKey, dayType) {
    var s = window.SCHEDULE.shuttle[dayType];
    return (s && s[dirKey]) ? s[dirKey] : [];
  }
  function specials(dayType) {
    return window.SCHEDULE.specialRoutes[dayType] || [];
  }
  function mergedTimeline(dir, dayType) {
    var reg = times(dir.key, dayType).map(function (t) { return { time: t, special: null }; });
    var sp = specials(dayType).filter(function (r) { return r.direction === dir.id; })
      .map(function (r) { return { time: r.time, special: r }; });
    return reg.concat(sp).sort(function (a, b) { return serviceMinutes(a.time) - serviceMinutes(b.time); });
  }
  /** What a direction's timeline plots: the distinct departure times in order, plus
      which of them are "going outside" trips (Palakkad Town / Wise Park). */
  function timelineStops(dir, dayType) {
    var list = [], special = {};
    mergedTimeline(dir, dayType).forEach(function (e) {
      if (list[list.length - 1] !== e.time) list.push(e.time);
      if (e.special) special[e.time] = e.special.kind;
    });
    return { times: list, specials: special };
  }
  function nextBusInfo(list, d, following) {
    following = following || 3; // previous + next + 3 more = 5 times on the timeline
    if (!list.length) return { previous: null, next: null, following: [], mins: null, frac: 0, ended: true };
    var nowMin = nowServiceMinutes(d);
    var mins = list.map(serviceMinutes);
    var i = mins.findIndex(function (m) { return m >= nowMin; });
    if (i === -1) return { previous: list[list.length - 1], next: null, following: [], mins: null, frac: 1, ended: true };
    var prev = i > 0 ? list[i - 1] : null;
    var until = mins[i] - nowMin;
    var frac = 1;
    if (prev != null) {
      var span = Math.max(mins[i] - mins[i - 1], 1);
      frac = Math.min(Math.max((nowMin - mins[i - 1]) / span, 0), 1);
    }
    return { previous: prev, next: list[i], following: list.slice(i + 1, i + 1 + following), mins: until, frac: frac, ended: false };
  }
  function hasDeparted(t, d) { return serviceMinutes(t) < nowServiceMinutes(d); }

  // ---- formatting -----------------------------------------------------------
  function timeLabel(hhmm) {
    var p = hhmm.split(":"), h = +p[0], m = +p[1];
    var ap = h >= 12 ? "pm" : "am";
    var hr = h % 12; if (hr === 0) hr = 12;
    return hr + ":" + (m < 10 ? "0" + m : m) + " " + ap;
  }
  function countdown(mins) {
    if (mins == null) return "";
    if (mins <= 0) return "departing now";
    if (mins === 1) return "in 1 min";
    if (mins < 60) return "in " + mins + " min";
    var h = Math.floor(mins / 60), m = mins % 60;
    return m === 0 ? "in " + h + "h" : "in " + h + "h " + m + "m";
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }

  // ---- state ----------------------------------------------------------------
  // The manual "holiday today" switch only applies to the service day it was
  // turned on for, so it is stored as that day's date rather than a flag.
  localStorage.removeItem("holiday"); // the old never-expiring flag
  var state = {
    theme: localStorage.getItem("theme") || "system",
    accent: localStorage.getItem("accent") || "amber",
    holidayDate: localStorage.getItem("holidayDate"),
    holidayTheme: localStorage.getItem("holidayTheme") !== "0",
    page: "bus",
    mess: "nila",
    messDay: null, // null = Today
    calFilter: "ALL",
    ttDay: null, // null = Today
  };
  var ACCENTS = {
    amber: "#FFB300", teal: "#26C6DA", violet: "#AB47BC", rose: "#EF5350", emerald: "#66BB6A",
  };
  var CATEGORY_COLOR = { HOLIDAY: "#EF5350", EXAM: "#FFB300", ACADEMIC: null, VACATION: "#66BB6A", MEETING: "#42A5F5" };

  function holidayOverrideOn(now) { return state.holidayDate === iso(serviceDay(now)); }

  function hexToRgba(hex, alpha) {
    var n = parseInt(hex.slice(1), 16);
    return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + alpha + ")";
  }
  function applyTheme() {
    var root = document.documentElement;
    if (state.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", state.theme);
    // On a gazetted holiday the page wears the holiday's color, unless that is switched off.
    var festive = todaysHoliday(currentTime());
    var accent = (festive && state.holidayTheme) ? festive.color : (ACCENTS[state.accent] || ACCENTS.amber);
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--card-tint", hexToRgba(accent, 0.16));
    document.querySelectorAll("[data-theme-opt]").forEach(function (b) {
      b.classList.toggle("sel", b.getAttribute("data-theme-opt") === state.theme);
    });
    document.querySelectorAll("[data-accent-opt]").forEach(function (b) {
      b.classList.toggle("sel", b.getAttribute("data-accent-opt") === state.accent);
    });
  }

  // ---- rendering ------------------------------------------------------------
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  var BUS_SVG = '<svg viewBox="0 0 24 24" class="busico" aria-hidden="true"><path fill="currentColor" d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4S4 2.5 4 6v10zM7.5 17A1.5 1.5 0 1 1 9 15.5 1.5 1.5 0 0 1 7.5 17zm9 0a1.5 1.5 0 1 1 1.5-1.5 1.5 1.5 0 0 1-1.5 1.5zM18 11H6V6h12z"/></svg>';

  var lastRenderedDay = null;

  function render() {
    var now = currentTime();
    // Yesterday's manual holiday switch has run out.
    if (state.holidayDate && !holidayOverrideOn(now)) {
      state.holidayDate = null;
      localStorage.removeItem("holidayDate");
    }
    var todayType = currentDayType(holidayOverrideOn(now), now);
    var festive = todaysHoliday(now);
    applyTheme();
    document.getElementById("clock").textContent = timeLabel(pad(now.getHours()) + ":" + pad(now.getMinutes()));

    renderWish(festive);

    // direction cards (timeline-widget style)
    var cards = document.getElementById("cards");
    cards.innerHTML = "";
    DIRS.forEach(function (dir) {
      cards.appendChild(directionCard(dir, todayType, now, festive));
    });

    renderHolidays(now);
    renderTimetable(now, todayType);
    renderHolidaySettings(now, festive);

    // The calendar and mess menu only change with the date or a tap, so don't rebuild them every tick.
    if (lastRenderedDay !== iso(now)) {
      lastRenderedDay = iso(now);
      renderCalendar(now, false);
      renderMess(now);
    }
  }

  function renderWish(festive) {
    var host = document.getElementById("wish");
    host.innerHTML = "";
    if (!festive) return;
    var day = fromIso(festive.date).getDay();
    var card = el("div", "wish");
    card.appendChild(el("div", "ic", festive.icon));
    var text = el("div");
    text.appendChild(el("div", "greet", esc(festive.greeting)));
    text.appendChild(el("div", "sub", "Today is " + esc(festive.name) +
      (day !== 0 && day !== 6 ? " — buses follow the holiday timetable." : ".")));
    card.appendChild(text);
    host.appendChild(card);
  }

  function directionCard(dir, dayType, now, festive) {
    var stops = timelineStops(dir, dayType);
    var info = nextBusInfo(stops.times, now);
    var nextKind = info.next ? stops.specials[info.next] : null;
    var card = el("div", "wcard");
    var head = el("div", "wc-head");
    head.appendChild(el("span", "wc-dir", dir.label));
    head.appendChild(el("span", "wc-now", timeLabel(pad(now.getHours()) + ":" + pad(now.getMinutes()))));
    card.appendChild(head);

    var next = el("div", "wc-next" + (nextKind ? " special" : ""));
    if (info.next == null) next.innerHTML = '<span class="muted">Service over for today' +
      (info.previous ? ' · last bus ' + timeLabel(info.previous) : '') + '</span>';
    else next.innerHTML = 'Next: <b>' + timeLabel(info.next) + '</b>' +
      (nextKind ? ' · ' + KIND[nextKind].short + ' bus' : '') + ' · ' + countdown(info.mins);
    card.appendChild(next);

    card.appendChild(timelineRow(info, stops.specials));

    var foot = el("div", "wc-foot");
    if (festive) foot.appendChild(el("span", "hol", festive.icon + " " + esc(festive.name)));
    else foot.appendChild(el("span", "muted", DAY_LABEL[dayType]));
    card.appendChild(foot);
    return card;
  }

  function timelineRow(info, specialKinds) {
    var stops = [];
    if (info.previous) stops.push(info.previous);
    if (info.next) stops.push(info.next);
    info.following.forEach(function (t) { stops.push(t); });

    var wrap = el("div", "timeline");
    if (!stops.length) { wrap.appendChild(el("div", "tl-empty muted", "No more buses today")); return wrap; }

    var track = el("div", "tl-track");
    var L = 6, R = 94, n = stops.length;
    function xp(i) { return n === 1 ? (L + R) / 2 : L + (R - L) * i / (n - 1); }
    // line
    track.appendChild(el("div", "tl-line"));
    var nextIdx = info.next == null ? -1 : (info.previous ? 1 : 0);
    stops.forEach(function (t, i) {
      var x = xp(i);
      // "Going outside" trips: same dot and label, in the special color, with a destination tag.
      var kind = specialKinds[t];
      var cls = (i === nextIdx ? " next" : "") + (kind ? " special" : "");
      var dot = el("div", "tl-dot" + cls);
      dot.style.left = x + "%";
      track.appendChild(dot);
      var lab = el("div", "tl-lab" + cls, timeLabel(t));
      lab.style.left = x + "%";
      track.appendChild(lab);
      if (kind) {
        var tag = el("div", "tl-tag" + (i === nextIdx ? " next" : ""), KIND[kind].short);
        tag.style.left = x + "%";
        track.appendChild(tag);
      }
    });
    // bus marker
    if (nextIdx !== -1) {
      var bx;
      if (info.previous && stops.length >= 2) bx = xp(0) + (xp(1) - xp(0)) * info.frac;
      else bx = xp(nextIdx);
      var bus = el("div", "tl-bus", "🚌");
      bus.style.left = bx + "%";
      track.appendChild(bus);
    }
    wrap.appendChild(track);
    return wrap;
  }

  function renderHolidays(now) {
    var todayIso = iso(now);
    var host = document.getElementById("holidays");
    host.innerHTML = "";
    var upcoming = HOLIDAYS.filter(function (h) { return h.date >= todayIso; }).slice(0, 5);
    if (!upcoming.length) {
      host.appendChild(el("div", "muted", "None left in this year's list"));
      return;
    }
    upcoming.forEach(function (h) {
      var row = el("div", "hol-row");
      row.appendChild(el("span", "ic", h.icon));
      row.appendChild(el("span", "nm", esc(h.shortName)));
      row.appendChild(el("span", "dt", weekdayDate(h.date)));
      row.appendChild(el("span", "left", daysLeftLabel(todayIso, h.date)));
      host.appendChild(row);
    });
  }

  function renderTimetable(now, todayType) {
    var shown = state.ttDay || todayType;
    document.querySelectorAll("[data-day-opt]").forEach(function (b) {
      var v = b.getAttribute("data-day-opt");
      b.classList.toggle("sel", (v === "today" && state.ttDay == null) || v === state.ttDay);
    });
    var host = document.getElementById("timetable");
    host.innerHTML = "";
    DIRS.forEach(function (dir) {
      host.appendChild(el("h3", "tt-dir", dir.label));
      var row = el("div", "chips");
      mergedTimeline(dir, shown).forEach(function (entry) {
        var past = state.ttDay == null && hasDeparted(entry.time, now);
        var chip = el("span", "chip" + (entry.special ? " special" : "") + (past ? " past" : ""));
        if (entry.special) chip.innerHTML = BUS_SVG;
        chip.appendChild(document.createTextNode(timeLabel(entry.time)));
        if (entry.special) {
          chip.title = KIND[entry.special.kind].name;
          chip.addEventListener("click", function () { showRoute(entry.special); });
        }
        row.appendChild(chip);
      });
      host.appendChild(row);
    });
  }

  function renderHolidaySettings(now, festive) {
    // On a weekday gazetted holiday the reduced timetable already applies, so
    // the switch just reports that instead of being a choice.
    var sd = serviceDay(now), gazetted = holidayOn(iso(sd));
    var auto = gazetted && sd.getDay() !== 0 && sd.getDay() !== 6;
    var hol = document.getElementById("holiday");
    hol.checked = auto || holidayOverrideOn(now);
    hol.disabled = !!auto;
    document.getElementById("holiday-note").textContent = auto
      ? gazetted.name + " — the Saturday/holiday timetable applies automatically"
      : "Use the reduced Saturday/holiday timetable · resets tomorrow";

    document.getElementById("holiday-theme").checked = state.holidayTheme;
    document.getElementById("holiday-theme-note").textContent = (festive && state.holidayTheme)
      ? "Showing " + festive.shortName + " colours today · turn off to keep your own accent"
      : "Use a holiday's colour on gazetted holidays";
  }

  function showRoute(r) {
    document.getElementById("dlg-title").textContent = KIND[r.kind].name + " · " + r.label;
    document.getElementById("dlg-body").textContent = r.summary || "";
    document.getElementById("dlg").showModal();
  }

  // ---- academic calendar ----------------------------------------------------
  function eventDateLabel(e) {
    if (e.start === e.end) return weekdayDate(e.start).replace(" ", ", ");
    // Spell out the years only for the few ranges that straddle New Year.
    var years = e.start.slice(0, 4) !== e.end.slice(0, 4);
    return shortDate(e.start, years) + " – " + shortDate(e.end, years);
  }
  function renderCalendar(now, scrollToUpcoming) {
    var todayIso = iso(now);
    document.querySelectorAll("[data-cal-opt]").forEach(function (b) {
      b.classList.toggle("sel", b.getAttribute("data-cal-opt") === state.calFilter);
    });
    var host = document.getElementById("calendar");
    host.innerHTML = "";
    var month = null, firstUpcoming = null;
    window.CALENDAR.events.forEach(function (e) {
      if (state.calFilter !== "ALL" && e.category !== state.calFilter) return;
      var m = e.start.slice(0, 7);
      var heading = null;
      if (m !== month) {
        month = m;
        heading = el("h3", "cal-month", MONTHS_LONG[+m.slice(5) - 1] + " " + m.slice(0, 4));
        host.appendChild(heading);
      }
      var past = e.end < todayIso, ongoing = !past && e.start <= todayIso;
      var row = el("div", "ev" + (past ? " past" : ""));
      var mark = el("div", "mark");
      if (e.icon) mark.textContent = e.icon;
      else {
        var dot = el("span", "dot");
        dot.style.background = CATEGORY_COLOR[e.category] || "var(--accent)";
        mark.appendChild(dot);
      }
      row.appendChild(mark);
      var body = el("div");
      var when = el("div", "when", esc(eventDateLabel(e)));
      if (ongoing) when.appendChild(el("span", "badge", e.start === e.end ? "TODAY" : "ONGOING"));
      body.appendChild(when);
      body.appendChild(el("div", "ttl", esc(e.title)));
      if (e.note) body.appendChild(el("div", "note", esc(e.note)));
      row.appendChild(body);
      host.appendChild(row);
      // Open on what's coming up rather than at January (keeping its month heading in view).
      if (!past && !firstUpcoming) firstUpcoming = heading || row;
    });
    if (scrollToUpcoming && firstUpcoming) firstUpcoming.scrollIntoView({ block: "start" });
  }

  // ---- mess menu -------------------------------------------------------------
  var MESS_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  var MESS_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
  var MEALS = [["breakfast", "Breakfast"], ["lunch", "Lunch"], ["tea", "Tea"], ["dinner", "Dinner"]];
  function renderMess(now) {
    var M = window.MESS, today = now.getDay();
    var shown = state.messDay == null ? today : state.messDay;
    document.querySelectorAll("[data-mess-opt]").forEach(function (b) {
      b.classList.toggle("sel", b.getAttribute("data-mess-opt") === state.mess);
    });
    document.getElementById("mess-nila").hidden = state.mess !== "nila";
    document.getElementById("mess-kedaram").hidden = state.mess !== "kedaram";

    document.getElementById("mess-provider").innerHTML =
      '<div class="ttl">' + esc(M.provider) + '</div><div class="note">Mess rate · ' + esc(M.rate) + '</div>';

    var days = document.getElementById("mess-days");
    days.innerHTML = "";
    function pill(label, sel, isToday, value) {
      var b = el("button", "tab" + (sel ? " sel" : "") + (isToday ? " today" : ""), label);
      b.addEventListener("click", function () { state.messDay = value; renderMess(currentTime()); });
      days.appendChild(b);
    }
    pill("Today", state.messDay == null, false, null);
    MESS_ORDER.forEach(function (d) {
      pill(WEEKDAYS[d], state.messDay === d, state.messDay == null && d === today, d);
    });

    var host = document.getElementById("mess-menu");
    host.innerHTML = "";
    var menu = M.days[MESS_DAYS[shown]] || {};
    MEALS.forEach(function (meal) {
      var card = el("div", "meal");
      card.appendChild(el("div", "lab", meal[1].toUpperCase()));
      card.appendChild(el("div", "txt", esc(menu[meal[0]] || "—")));
      host.appendChild(card);
    });
    var common = el("div", "meal common");
    common.appendChild(el("div", "ttl", "Every day also includes"));
    MEALS.forEach(function (meal) {
      common.appendChild(el("div", "lab", meal[1]));
      common.appendChild(el("div", "txt", esc(M.common[meal[0]] || "")));
    });
    host.appendChild(common);
    host.appendChild(el("div", "mess-note", esc(M.note)));
  }

  // ---- campus map -------------------------------------------------------------
  // Drawn as SVG from window.CAMPUS_MAP (map.js): coordinates are metres from the
  // map's north-west corner, and pan/zoom just moves the SVG viewBox.
  var mapState = null;
  function initMap() {
    var M = window.CAMPUS_MAP, svg = document.getElementById("map");
    if (mapState) { fitMapView(mapState.view); return; }
    var NS = "http://www.w3.org/2000/svg";
    function node(tag, attrs) {
      var n = document.createElementNS(NS, tag);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    }
    function points(p) {
      var out = [];
      for (var i = 0; i + 1 < p.length; i += 2) out.push(p[i] + "," + p[i + 1]);
      return out.join(" ");
    }
    M.areas.forEach(function (a) { svg.appendChild(node("polygon", { "class": "a-" + a.k, points: points(a.p) })); });
    M.lines.forEach(function (l) { svg.appendChild(node("polyline", { "class": "l l-" + l.k, points: points(l.p) })); });
    var texts = M.labels.map(function (l) {
      var t = node("text", { "class": "t-" + l.k, x: l.x, y: l.y });
      t.textContent = l.t;
      svg.appendChild(t);
      return { el: t, k: l.k };
    });
    mapState = { box: null, view: M.views[0], texts: texts };

    var pills = document.getElementById("map-views");
    M.views.forEach(function (v) {
      var b = el("button", "tab", v.name);
      b.addEventListener("click", function () { fitMapView(v); });
      pills.appendChild(b);
      v.pill = b;
    });

    // Pointer gestures: one pointer drags, two pinch-zoom; wheel and +/- also zoom.
    var pointers = {}, lastDist = 0;
    function metresPerPx() { return mapState.box[2] / svg.clientWidth; }
    function zoomAt(factor, cx, cy) {
      var b = mapState.box, r = svg.getBoundingClientRect();
      var fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;
      var w = Math.min(Math.max(b[2] / factor, 60), M.w * 1.3), h = w * b[3] / b[2];
      setMapBox([b[0] + (b[2] - w) * fx, b[1] + (b[3] - h) * fy, w, h], null);
    }
    svg.addEventListener("pointerdown", function (e) {
      svg.setPointerCapture(e.pointerId);
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      lastDist = 0;
    });
    svg.addEventListener("pointermove", function (e) {
      var p = pointers[e.pointerId];
      if (!p) return;
      var ids = Object.keys(pointers);
      if (ids.length === 1) {
        var k = metresPerPx(), b = mapState.box;
        setMapBox([b[0] - (e.clientX - p.x) * k, b[1] - (e.clientY - p.y) * k, b[2], b[3]], null);
      }
      p.x = e.clientX; p.y = e.clientY;
      if (ids.length === 2) {
        var a = pointers[ids[0]], c = pointers[ids[1]];
        var dist = Math.hypot(a.x - c.x, a.y - c.y);
        if (lastDist) zoomAt(dist / lastDist, (a.x + c.x) / 2, (a.y + c.y) / 2);
        lastDist = dist;
      }
    });
    function release(e) { delete pointers[e.pointerId]; lastDist = 0; }
    svg.addEventListener("pointerup", release);
    svg.addEventListener("pointercancel", release);
    svg.addEventListener("wheel", function (e) {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY);
    }, { passive: false });
    function centreZoom(f) {
      var r = svg.getBoundingClientRect();
      zoomAt(f, r.left + r.width / 2, r.top + r.height / 2);
    }
    document.getElementById("map-in").addEventListener("click", function () { centreZoom(1.5); });
    document.getElementById("map-out").addEventListener("click", function () { centreZoom(1 / 1.5); });
    window.addEventListener("resize", function () { if (state.page === "map" && mapState.view) fitMapView(mapState.view); });

    fitMapView(M.views[0]);
  }
  /** Shows `box` = [x, y, width, height] in map metres; `view` is the preset it came from, if any. */
  function setMapBox(box, view) {
    var M = window.CAMPUS_MAP, svg = document.getElementById("map");
    mapState.box = box;
    mapState.view = view;
    svg.setAttribute("viewBox", box.join(" "));
    M.views.forEach(function (v) { if (v.pill) v.pill.classList.toggle("sel", v === view); });
    // Keep label text a constant size on screen; small names appear only once zoomed in.
    var k = box[2] / (svg.clientWidth || 1); // metres per px
    // Main names first; a name that would run into one already shown waits for more zoom.
    var placed = [], rank = { main: 0, campus: 1, minor: 2 };
    mapState.texts.slice().sort(function (p, q) { return rank[p.k] - rank[q.k]; }).forEach(function (t) {
      var px = t.k === "minor" ? 11 : t.k === "campus" ? 13 : 12;
      t.el.setAttribute("font-size", px * k);
      t.el.setAttribute("stroke-width", 3 * k);
      var hide = (t.k === "minor" && k > 1.6) || (t.k === "campus" && k < 1.6);
      if (!hide) {
        var half = t.el.textContent.length * px * 0.31 * k, x = +t.el.getAttribute("x"), y = +t.el.getAttribute("y");
        var box = [x - half, y - px * k, x + half, y + px * k * 0.3];
        hide = placed.some(function (o) { return box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1]; });
        if (!hide) placed.push(box);
      }
      t.el.style.display = hide ? "none" : "";
    });
  }
  function fitMapView(view) {
    var svg = document.getElementById("map"), r = view.r;
    // Grow the preset rectangle to the box's shape so it is centred, not stretched.
    var w = r[2] - r[0], h = r[3] - r[1], aspect = (svg.clientWidth || 1) / (svg.clientHeight || 1);
    if (w / h < aspect) { var nw = h * aspect; r = [r[0] - (nw - w) / 2, r[1], 0, 0]; w = nw; }
    else { var nh = w / aspect; r = [r[0], r[1] - (nh - h) / 2, 0, 0]; h = nh; }
    setMapBox([r[0], r[1], w, h], view);
  }

  function showPage(page) {
    state.page = page;
    document.getElementById("page-bus").hidden = page !== "bus";
    document.getElementById("page-calendar").hidden = page !== "calendar";
    document.getElementById("page-mess").hidden = page !== "mess";
    document.getElementById("page-map").hidden = page !== "map";
    if (page === "map") initMap();
    document.querySelectorAll("[data-page-opt]").forEach(function (b) {
      b.classList.toggle("sel", b.getAttribute("data-page-opt") === page);
    });
    if (page === "calendar") renderCalendar(currentTime(), true);
    else window.scrollTo(0, 0);
    if (page === "mess") renderMess(currentTime());
  }

  // ---- wiring ---------------------------------------------------------------
  function initControls() {
    document.querySelectorAll("[data-theme-opt]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.theme = b.getAttribute("data-theme-opt");
        localStorage.setItem("theme", state.theme); applyTheme();
      });
    });
    document.querySelectorAll("[data-accent-opt]").forEach(function (b) {
      b.style.background = ACCENTS[b.getAttribute("data-accent-opt")];
      b.addEventListener("click", function () {
        state.accent = b.getAttribute("data-accent-opt");
        localStorage.setItem("accent", state.accent); applyTheme();
      });
    });
    document.querySelectorAll("[data-day-opt]").forEach(function (b) {
      b.addEventListener("click", function () {
        var v = b.getAttribute("data-day-opt");
        state.ttDay = v === "today" ? null : v;
        render();
      });
    });
    document.querySelectorAll("[data-page-opt]").forEach(function (b) {
      b.addEventListener("click", function () { showPage(b.getAttribute("data-page-opt")); });
    });
    document.querySelectorAll("[data-cal-opt]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.calFilter = b.getAttribute("data-cal-opt");
        renderCalendar(currentTime(), true);
      });
    });
    document.querySelectorAll("[data-mess-opt]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.mess = b.getAttribute("data-mess-opt");
        renderMess(currentTime());
      });
    });
    document.getElementById("hol-all").addEventListener("click", function () {
      state.calFilter = "HOLIDAY";
      showPage("calendar");
    });
    var hol = document.getElementById("holiday");
    hol.addEventListener("change", function () {
      if (hol.checked) {
        state.holidayDate = iso(serviceDay(currentTime()));
        localStorage.setItem("holidayDate", state.holidayDate);
      } else {
        state.holidayDate = null;
        localStorage.removeItem("holidayDate");
      }
      render();
    });
    var holTheme = document.getElementById("holiday-theme");
    holTheme.addEventListener("change", function () {
      state.holidayTheme = holTheme.checked;
      localStorage.setItem("holidayTheme", holTheme.checked ? "1" : "0");
      render();
    });
    document.getElementById("dlg-close").addEventListener("click", function () {
      document.getElementById("dlg").close();
    });
    document.getElementById("eff").textContent = window.SCHEDULE.effectiveDate || "";
  }

  document.addEventListener("DOMContentLoaded", function () {
    initControls();
    initInstall();
    render();
    showPage({ "#cal": "calendar", "#mess": "mess", "#campusmap": "map" }[location.hash] || "bus"); // deep links
    setInterval(render, 15000); // keep countdowns live
    document.addEventListener("visibilitychange", function () { if (!document.hidden) render(); });
    if ("serviceWorker" in navigator) {
      // When a newer version of the app takes over, reload once so it shows straight away.
      var hadController = !!navigator.serviceWorker.controller, reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (hadController && !reloaded) { reloaded = true; location.reload(); }
      });
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
  });
})();
