/* SimpleView — options page logic.
   Plain classic script (no modules). Reads/writes chrome.storage.sync key "settings". */
(function () {
  "use strict";

  // Duplicated verbatim from ARCHITECTURE §4 DEFAULT_SETTINGS.
  // The options page cannot share content-script scope, so this is a copy.
  // KEEP IN SYNC with content/settings.js (its DEFAULTS).
  var DEFAULTS = {
    version: 1,
    typography: "simpleview",      // "simpleview" | "original"
    theme: "light",                // "light" | "dark" | "sepia"
    readingWidth: "medium",        // "narrow" | "medium" | "wide"
    fontScale: 1.0,                // 0.85 – 1.5
    showReadingTime: true,
    elements: {
      images: true,
      captions: true,
      byline: true,
      publishDate: true,
      tables: true,
      codeBlocks: true,
      links: true,                 // false => unwrap <a> to plain text
      embeds: "placeholder",       // "placeholder" | "keep" | "remove"
      comments: false,
      authorBio: false,
      relatedLinks: false
    },
    autoSites: []                  // ["example.com", "example.com/blog", ...]
  };

  // ---- helpers ----------------------------------------------------------

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  // Deep-merge stored values over a deep CLONE of defaults (forward-compatible).
  // Returns a fresh object every call: plain objects recurse, arrays are sliced,
  // scalars copied — so nested objects are never aliased to the source (e.g. DEFAULTS).
  function deepMerge(base, override) {
    var out = Array.isArray(base) ? base.slice() : {};
    var k;
    if (isPlainObject(base)) {
      for (k in base) {
        if (!Object.prototype.hasOwnProperty.call(base, k)) continue;
        var bv = base[k];
        if (isPlainObject(bv)) out[k] = deepMerge(bv, undefined);
        else if (Array.isArray(bv)) out[k] = bv.slice();
        else out[k] = bv;
      }
    }
    if (!isPlainObject(override)) return out;
    for (k in override) {
      if (!Object.prototype.hasOwnProperty.call(override, k)) continue;
      var ov = override[k];
      if (isPlainObject(ov) && isPlainObject(out[k])) {
        out[k] = deepMerge(out[k], ov);
      } else if (isPlainObject(ov)) {
        out[k] = deepMerge(ov, undefined);
      } else if (Array.isArray(ov)) {
        out[k] = ov.slice();
      } else if (ov !== undefined) {
        out[k] = ov;
      }
    }
    return out;
  }

  // Maps the elements-checklist checkbox names to schema keys under elements.
  var ELEMENT_KEYS = {
    "el-images": "images",
    "el-captions": "captions",
    "el-byline": "byline",
    "el-publishDate": "publishDate",
    "el-tables": "tables",
    "el-codeBlocks": "codeBlocks",
    "el-links": "links",
    "el-comments": "comments",
    "el-authorBio": "authorBio",
    "el-relatedLinks": "relatedLinks"
  };

  // Normalize the auto-sites textarea: trim, drop empties/dupes, strip scheme + leading
  // www., lowercase. Preserves first-seen order.
  function parseAutoSites(text) {
    var lines = String(text || "").split(/\r?\n/);
    var seen = {};
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i].trim().toLowerCase();
      if (!s) continue;
      s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme
      s = s.replace(/^www\./, "");                   // strip leading www.
      s = s.replace(/\/+$/, "");                      // drop trailing slashes
      if (!s || Object.prototype.hasOwnProperty.call(seen, s)) continue;
      seen[s] = true;
      out.push(s);
    }
    return out;
  }

  // ---- DOM refs ---------------------------------------------------------

  var form, fontScaleEl, fontScaleValueEl, autoSitesEl, savedEl;

  // ---- populate from settings ------------------------------------------

  function setRadio(name, value) {
    var el = form.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (el) el.checked = true;
  }

  function populate(settings) {
    setRadio("theme", settings.theme);
    setRadio("typography", settings.typography);
    setRadio("readingWidth", settings.readingWidth);

    var pct = Math.round(settings.fontScale * 100);
    fontScaleEl.value = String(pct);
    fontScaleValueEl.textContent = pct + "%";

    form.elements["showReadingTime"].checked = !!settings.showReadingTime;

    var el = settings.elements || {};
    for (var name in ELEMENT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(ELEMENT_KEYS, name)) continue;
      var input = form.elements[name];
      if (input) input.checked = !!el[ELEMENT_KEYS[name]];
    }
    setRadio("embeds", el.embeds);

    autoSitesEl.value = (settings.autoSites || []).join("\n");
  }

  // ---- build settings from the form ------------------------------------

  function getRadio(name) {
    var el = form.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }

  function collect() {
    var s = deepMerge(DEFAULTS, {});

    s.theme = getRadio("theme") || DEFAULTS.theme;
    s.typography = getRadio("typography") || DEFAULTS.typography;
    s.readingWidth = getRadio("readingWidth") || DEFAULTS.readingWidth;

    var pct = parseInt(fontScaleEl.value, 10);
    if (isNaN(pct)) pct = 100;
    s.fontScale = pct / 100;

    s.showReadingTime = !!form.elements["showReadingTime"].checked;

    for (var name in ELEMENT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(ELEMENT_KEYS, name)) continue;
      var input = form.elements[name];
      s.elements[ELEMENT_KEYS[name]] = !!(input && input.checked);
    }
    s.elements.embeds = getRadio("embeds") || DEFAULTS.elements.embeds;

    s.autoSites = parseAutoSites(autoSitesEl.value);
    return s;
  }

  // ---- save -------------------------------------------------------------

  var savedTimer = null;
  function showSaved() {
    savedEl.classList.add("show");
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(function () {
      savedEl.classList.remove("show");
    }, 1500);
  }

  function save() {
    var settings = collect();
    chrome.storage.sync.set({ settings: settings }, function () {
      if (chrome.runtime.lastError) return; // stay quiet on failure
      showSaved();
    });
  }

  var debounceTimer = null;
  function saveDebounced() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(save, 300);
  }
  // Flush a pending debounced save right now (e.g. before the tab goes away).
  function flushPending() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      save();
    }
  }

  // ---- event wiring -----------------------------------------------------

  // The continuous controls (range slider, site-list textarea) drive the
  // debounced path on 'input'. Everything else (checkboxes, radios) saves
  // immediately on 'change'. Splitting by event type avoids the double write
  // that happens when both 'input' and 'change' fire for one user action.
  function onInput(e) {
    var t = e.target;
    if (t !== fontScaleEl && t !== autoSitesEl) return; // handled by onChange
    if (t === fontScaleEl) {
      fontScaleValueEl.textContent = fontScaleEl.value + "%"; // live label
    }
    saveDebounced();
  }

  function onChange(e) {
    var t = e.target;
    if (t === fontScaleEl || t === autoSitesEl) return; // handled by onInput
    save();
  }

  function init() {
    form = document.getElementById("settings-form");
    fontScaleEl = document.getElementById("fontScale");
    fontScaleValueEl = document.getElementById("fontScaleValue");
    autoSitesEl = document.getElementById("autoSites");
    savedEl = document.getElementById("saved");

    chrome.storage.sync.get("settings", function (data) {
      var stored = (data && data.settings) || {};
      var merged = deepMerge(DEFAULTS, stored);
      populate(merged);

      // Delegated handlers for the whole form. 'input' drives the debounced
      // continuous controls; 'change' drives the immediate-save controls.
      form.addEventListener("input", onInput);
      form.addEventListener("change", onChange);

      // Flush any pending debounced save if the tab is hidden/closed within the
      // 300ms window, so the last keystrokes aren't lost.
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") flushPending();
      });
      window.addEventListener("pagehide", flushPending);
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
