/* IITPKD Campus Buddy — web app logic.
   Ports the Android app's schedule maths (BusSchedule.kt) to the browser and
   renders the next-bus cards, per-direction timelines, and full timetable.
   Fully offline: all data comes from window.SCHEDULE (schedule.js). */
(function () {
  "use strict";

  // ---- installability (Add to Home Screen / desktop install) ---------------
  var deferredPrompt = null;
  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    var bar = document.getElementById("installbar");
    if (bar && !isStandalone()) bar.hidden = false;
  });
  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    var bar = document.getElementById("installbar");
    if (bar) bar.hidden = true;
  });
  function initInstall() {
    var btn = document.getElementById("install");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () {
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
  function currentDayType(holiday, d) {
    if (holiday) return "saturday";
    var day = d.getDay(); // 0 Sun .. 6 Sat
    if (d.getHours() < CUTOVER_HOUR) day = (day + 6) % 7; // roll back to previous day
    if (day === 0) return "sunday";
    if (day === 6) return "saturday";
    return "working";
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
  function nextBusInfo(list, d, following) {
    following = following || 4;
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

  // ---- state ----------------------------------------------------------------
  var state = {
    theme: localStorage.getItem("theme") || "system",
    accent: localStorage.getItem("accent") || "amber",
    holiday: localStorage.getItem("holiday") === "1",
    ttDay: null, // null = Today
  };
  var ACCENTS = {
    amber: "#FFB300", teal: "#26C6DA", violet: "#AB47BC", rose: "#EF5350", emerald: "#66BB6A",
  };

  function applyTheme() {
    var root = document.documentElement;
    if (state.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", state.theme);
    root.style.setProperty("--accent", ACCENTS[state.accent] || ACCENTS.amber);
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

  function render() {
    var now = new Date();
    var todayType = currentDayType(state.holiday, now);
    document.getElementById("clock").textContent = timeLabel(pad(now.getHours()) + ":" + pad(now.getMinutes()));

    // direction cards (timeline-widget style)
    var cards = document.getElementById("cards");
    cards.innerHTML = "";
    DIRS.forEach(function (dir) {
      cards.appendChild(directionCard(dir, todayType, now));
    });

    // full timetable
    renderTimetable(now, todayType);
  }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function directionCard(dir, dayType, now) {
    var info = nextBusInfo(times(dir.key, dayType), now);
    var card = el("div", "wcard");
    var head = el("div", "wc-head");
    head.appendChild(el("span", "wc-dir", dir.label));
    head.appendChild(el("span", "wc-now", timeLabel(pad(now.getHours()) + ":" + pad(now.getMinutes()))));
    card.appendChild(head);

    var next = el("div", "wc-next");
    if (info.next == null) next.innerHTML = '<span class="muted">Service over for today' +
      (info.previous ? ' · last bus ' + timeLabel(info.previous) : '') + '</span>';
    else next.innerHTML = 'Next: <b>' + timeLabel(info.next) + '</b> · ' + countdown(info.mins);
    card.appendChild(next);

    card.appendChild(timelineRow(info));

    var foot = el("div", "wc-foot");
    foot.appendChild(el("span", "muted", DAY_LABEL[dayType]));
    card.appendChild(foot);
    return card;
  }

  function timelineRow(info) {
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
      var dot = el("div", "tl-dot" + (i === nextIdx ? " next" : ""));
      dot.style.left = x + "%";
      track.appendChild(dot);
      var lab = el("div", "tl-lab" + (i === nextIdx ? " next" : ""), timeLabel(t));
      lab.style.left = x + "%";
      track.appendChild(lab);
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
          chip.title = entry.special.kind === "PALAKKAD_TOWN" ? "Palakkad Town" : "Wise Park Junction";
          chip.addEventListener("click", function () { showRoute(entry.special); });
        }
        row.appendChild(chip);
      });
      host.appendChild(row);
    });
  }

  function showRoute(r) {
    var kind = r.kind === "PALAKKAD_TOWN" ? "Palakkad Town" : "Wise Park Junction";
    document.getElementById("dlg-title").textContent = kind + " · " + r.label;
    document.getElementById("dlg-body").textContent = r.summary || "";
    document.getElementById("dlg").showModal();
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
    var hol = document.getElementById("holiday");
    hol.checked = state.holiday;
    hol.addEventListener("change", function () {
      state.holiday = hol.checked; localStorage.setItem("holiday", hol.checked ? "1" : "0"); render();
    });
    document.getElementById("dlg-close").addEventListener("click", function () {
      document.getElementById("dlg").close();
    });
    document.getElementById("eff").textContent = window.SCHEDULE.effectiveDate || "";
  }

  document.addEventListener("DOMContentLoaded", function () {
    applyTheme();
    initControls();
    initInstall();
    render();
    setInterval(render, 15000); // keep countdowns live
    document.addEventListener("visibilitychange", function () { if (!document.hidden) render(); });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});
  });
})();
