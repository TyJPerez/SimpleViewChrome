// content/settings.js — shared defaults, deep-merge load, and site-list matching.
// Classic script; shares scope via window.__simpleView.
(function () {
  "use strict";

  window.__simpleView = window.__simpleView || {};

  // Verbatim DEFAULT_SETTINGS from ARCHITECTURE §4.
  var DEFAULTS = {
    version: 1,
    typography: "simpleview", // "simpleview" | "original"
    theme: "light", // "light" | "dark" | "sepia"
    readingWidth: "medium", // "narrow" | "medium" | "wide"
    fontScale: 1.0, // 0.85 - 1.5
    showReadingTime: true,
    elements: {
      images: true,
      captions: true,
      byline: true,
      publishDate: true,
      tables: true,
      codeBlocks: true,
      links: true, // false => unwrap <a> to plain text
      embeds: "placeholder", // "placeholder" | "keep" | "remove"
      comments: false,
      authorBio: false,
      relatedLinks: false
    },
    autoSites: [] // ["example.com", "example.com/blog", ...]
  };

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  // Deep-merge `source` over a deep clone of `base`. Arrays are replaced wholesale.
  function deepMerge(base, source) {
    var out = Array.isArray(base) ? base.slice() : isPlainObject(base) ? {} : base;
    if (isPlainObject(base)) {
      for (var k in base) {
        if (Object.prototype.hasOwnProperty.call(base, k)) {
          out[k] = deepMerge(base[k], undefined);
        }
      }
    }
    if (isPlainObject(base) && isPlainObject(source)) {
      for (var sk in source) {
        if (Object.prototype.hasOwnProperty.call(source, sk)) {
          if (isPlainObject(base[sk]) && isPlainObject(source[sk])) {
            out[sk] = deepMerge(base[sk], source[sk]);
          } else if (source[sk] !== undefined) {
            out[sk] = isPlainObject(source[sk]) ? deepMerge({}, source[sk]) : source[sk];
          }
        }
      }
    } else if (source !== undefined && !isPlainObject(base)) {
      out = source;
    }
    return out;
  }

  // Returns a Promise of stored settings deep-merged over DEFAULTS.
  function load() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get("settings", function (data) {
          var stored = data && data.settings ? data.settings : {};
          resolve(deepMerge(DEFAULTS, stored));
        });
      } catch (e) {
        resolve(deepMerge(DEFAULTS, {}));
      }
    });
  }

  // Normalize a host/pattern: lowercase, strip scheme, strip leading www.
  function stripScheme(s) {
    return String(s).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  }
  function stripWww(host) {
    return host.replace(/^www\./i, "");
  }

  // ARCHITECTURE §4 / SPEC §1.2 matching. Pattern: host[/path].
  function matchesSiteList(url, list) {
    if (!list || !list.length) return false;
    var pageHost, pagePath;
    try {
      var u = new URL(url);
      pageHost = stripWww(u.hostname.toLowerCase());
      pagePath = u.pathname || "/";
    } catch (e) {
      // Fallback parse if URL constructor unavailable / url malformed.
      var raw = stripScheme(String(url).toLowerCase());
      var slash = raw.indexOf("/");
      pageHost = stripWww(slash === -1 ? raw : raw.slice(0, slash));
      pagePath = slash === -1 ? "/" : raw.slice(slash);
    }

    for (var i = 0; i < list.length; i++) {
      var pattern = list[i];
      if (pattern == null) continue;
      pattern = stripScheme(String(pattern).trim().toLowerCase());
      if (!pattern) continue;
      pattern = stripWww(pattern);

      var pSlash = pattern.indexOf("/");
      var pHost = pSlash === -1 ? pattern : pattern.slice(0, pSlash);
      var pPath = pSlash === -1 ? "" : pattern.slice(pSlash); // includes leading "/"
      if (!pHost) continue;

      // Host: exact or subdomain match.
      var hostOk = pageHost === pHost || pageHost.slice(-(pHost.length + 1)) === "." + pHost;
      if (!hostOk) continue;

      // Path: prefix match when a path is given.
      if (pPath && pPath !== "/") {
        var prefix = pPath.replace(/\/+$/, ""); // drop trailing slash(es)
        if (prefix) {
          var path = pagePath;
          if (path === prefix || path.indexOf(prefix + "/") === 0 || path.indexOf(prefix) === 0) {
            // path.indexOf(prefix)===0 catches "/blog" matching "/blog"; guard against
            // "/blogfoo" matching "/blog" by requiring boundary.
            if (path === prefix || path.charAt(prefix.length) === "/" || path.length === prefix.length) {
              return true;
            }
            // fallthrough: treat as no match for partial-segment overlap
            continue;
          }
          continue;
        }
      }
      return true;
    }
    return false;
  }

  window.__simpleView.settings = {
    DEFAULTS: DEFAULTS,
    load: load,
    matchesSiteList: matchesSiteList
  };
})();
