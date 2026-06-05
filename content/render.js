// content/render.js — builds the Simple View DOM, swaps/restores the body.
// Classic script; shares scope via window.__simpleView.
(function () {
  "use strict";

  window.__simpleView = window.__simpleView || {};

  var THEME_CLASS = { light: "sv-light", dark: "sv-dark", sepia: "sv-sepia" };
  var WIDTH_CLASS = { narrow: "sv-width-narrow", medium: "sv-width-medium", wide: "sv-width-wide" };
  // Theme background values mirror STYLE_GUIDE §1 --sv-bg, to avoid white flash.
  var THEME_BG = { light: "#FAF9F6", dark: "#161615", sepia: "#F4ECD8" };

  var state = window.__simpleView.state || { active: false, activating: false, originalBody: null, scrollY: 0 };
  if (typeof state.activating !== "boolean") state.activating = false;
  window.__simpleView.state = state;

  var _cssText = null; // cached stylesheet text

  function fetchCss() {
    if (_cssText !== null) return Promise.resolve(_cssText);
    // getURL throws if the extension context has been invalidated (e.g. after a
    // reload). Don't let that escape into rerender/activate — fall back to "".
    var url;
    try {
      url = chrome.runtime.getURL("styles/simpleview.css");
    } catch (e) {
      return Promise.resolve(_cssText || "");
    }
    return fetch(url)
      .then(function (r) { return r.text(); })
      .then(function (t) { _cssText = t; return t; })
      .catch(function () { _cssText = ""; return ""; });
  }

  function pauseMedia() {
    var media = document.querySelectorAll("video, audio");
    for (var i = 0; i < media.length; i++) {
      try { media[i].pause(); } catch (e) { /* ignore */ }
    }
  }

  function computedFont(el, prop) {
    try {
      return window.getComputedStyle(el)[prop] || "";
    } catch (e) { return ""; }
  }

  function captureOriginalFonts() {
    var body = document.body;
    var bodyFont = body ? computedFont(body, "fontFamily") : "";
    var heading = document.querySelector("h1, h2");
    var headingFont = heading ? computedFont(heading, "fontFamily") : bodyFont;
    return { body: bodyFont, heading: headingFont || bodyFont };
  }

  // Format an ISO-ish date string to a readable date; "" if invalid.
  function formatDate(s) {
    if (!s) return "";
    var d = new Date(s);
    if (isNaN(d.getTime())) return "";
    try {
      return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    } catch (e) {
      return d.toDateString();
    }
  }

  // Build the .sv-container element (detached) for a given article+settings.
  function buildContainer(article, settings, fonts) {
    var doc = document;
    var container = doc.createElement("div");
    var classes = ["sv-container"];
    classes.push(THEME_CLASS[settings.theme] || THEME_CLASS.light);
    classes.push(WIDTH_CLASS[settings.readingWidth] || WIDTH_CLASS.medium);
    classes.push(settings.typography === "original" ? "sv-type-original" : "sv-type-simpleview");
    container.className = classes.join(" ");

    var scale = Number(settings.fontScale);
    if (!isFinite(scale) || scale <= 0) scale = 1.0;
    container.style.setProperty("--sv-font-scale", String(scale));

    if (settings.typography === "original" && fonts) {
      if (fonts.body) container.style.setProperty("--sv-font-body-original", fonts.body);
      if (fonts.heading) container.style.setProperty("--sv-font-heading-original", fonts.heading);
    }

    // Measured reading column: the container is full-bleed (background), while
    // .sv-content holds the centered max-width measure (CSS width classes target
    // this child). All article children live inside .sv-content.
    var content = doc.createElement("div");
    content.className = "sv-content";

    // 1. Headline
    var h1 = doc.createElement("h1");
    h1.className = "sv-headline";
    h1.textContent = article.title || "";
    content.appendChild(h1);

    // 2. Deck / subhead — omitted in v1 (excerpt frequently duplicates the first
    //    paragraph; emitting it risks redundancy). Intentionally left out.

    // 3. Meta row
    var meta = doc.createElement("div");
    meta.className = "sv-meta";
    var parts = [];

    if (settings.elements && settings.elements.byline !== false && article.byline) {
      var by = doc.createElement("span");
      by.className = "sv-byline";
      by.textContent = article.byline;
      parts.push(by);
    }
    var dateStr = formatDate(article.publishedTime);
    if (settings.elements && settings.elements.publishDate !== false && dateStr) {
      var dt = doc.createElement("span");
      dt.className = "sv-date";
      dt.textContent = dateStr;
      parts.push(dt);
    }
    if (settings.showReadingTime !== false && article.readingMinutes) {
      var rt = doc.createElement("span");
      rt.className = "sv-readtime";
      rt.textContent = article.readingMinutes + " min read";
      parts.push(rt);
    }
    for (var i = 0; i < parts.length; i++) {
      if (i > 0) meta.appendChild(doc.createTextNode(" · "));
      meta.appendChild(parts[i]);
    }
    if (parts.length) content.appendChild(meta);

    // 4. Thin rule
    var hr = doc.createElement("hr");
    hr.className = "sv-rule";
    content.appendChild(hr);

    // 5. Article body
    var body = doc.createElement("div");
    body.className = "sv-body";
    // article.contentNode is a detached element; import its children.
    var contentNode = article.contentNode;
    if (contentNode) {
      // Clone so rerender can reuse the same article object safely.
      var clone = contentNode.cloneNode(true);
      while (clone.firstChild) body.appendChild(clone.firstChild);
    }
    content.appendChild(body);

    // 6. Footer
    var footer = doc.createElement("footer");
    footer.className = "sv-footer";
    var frule = doc.createElement("hr");
    frule.className = "sv-rule";
    footer.appendChild(frule);
    var ftext = doc.createElement("span");
    ftext.appendChild(doc.createTextNode("Simplified by SimpleView · "));
    var viewOrig = doc.createElement("a");
    viewOrig.href = "#";
    viewOrig.className = "sv-view-original";
    viewOrig.textContent = "View original";
    viewOrig.addEventListener("click", function (ev) {
      ev.preventDefault();
      deactivate();
      // Notify main of state change.
      try {
        chrome.runtime.sendMessage({ type: "SV_STATE", active: false });
      } catch (e) { /* ignore */ }
    });
    ftext.appendChild(viewOrig);
    footer.appendChild(ftext);
    content.appendChild(footer);

    container.appendChild(content);
    return container;
  }

  // Build the shadow-host root <div id="simpleview-root"> with an open shadow
  // root containing <style> + the container. Returns the host element.
  function buildRoot(article, settings, fonts, cssText) {
    var host = document.createElement("div");
    host.id = "simpleview-root";
    var shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = cssText || "";
    shadow.appendChild(style);
    shadow.appendChild(buildContainer(article, settings, fonts));
    return host;
  }

  // activate: build full replacement body first, then swap. Any throw before
  // the swap leaves the live DOM untouched (ARCHITECTURE §9).
  function activate(article, settings) {
    // Synchronous in-flight latch: set BEFORE any async work so a second rapid
    // SV_TOGGLE can't pass the guard and capture the already-swapped body as
    // the "original" (which would permanently lose the real one).
    if (state.active || state.activating) return Promise.resolve();
    state.activating = true;
    pauseMedia();
    var scrollY = window.scrollY || window.pageYOffset || 0;
    var fonts = settings.typography === "original" ? captureOriginalFonts() : null;

    return fetchCss().then(function (cssText) {
      // Build everything detached first.
      var newBody = document.createElement("body");
      var bg = THEME_BG[settings.theme] || THEME_BG.light;
      newBody.style.background = bg;
      newBody.style.margin = "0";
      var host = buildRoot(article, settings, fonts, cssText);
      newBody.appendChild(host);

      // Swap — wrap in try/catch that restores on failure.
      var oldBody = document.body;
      try {
        if (oldBody && oldBody.parentNode) {
          oldBody.parentNode.replaceChild(newBody, oldBody);
        } else {
          document.documentElement.appendChild(newBody);
        }
      } catch (e) {
        // Restore: ensure original body is present.
        try {
          if (oldBody && !oldBody.parentNode) {
            document.documentElement.appendChild(oldBody);
          }
        } catch (e2) { /* ignore */ }
        throw e;
      }

      state.active = true;
      state.originalBody = oldBody;
      state.scrollY = scrollY;
      // Reading view starts at the top.
      try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    }).finally(function () {
      // Clear the latch on every path: success, throw, or the no-op above.
      state.activating = false;
    });
  }

  function deactivate() {
    if (!state.active) return;
    var current = document.body;
    var orig = state.originalBody;
    try {
      if (orig) {
        if (current && current.parentNode) {
          current.parentNode.replaceChild(orig, current);
        } else {
          document.documentElement.appendChild(orig);
        }
      }
    } catch (e) { /* leave page as-is; best effort */ }

    var y = state.scrollY;
    state.active = false;
    state.originalBody = null;
    var savedY = y;
    try { window.scrollTo(0, savedY); } catch (e) { /* ignore */ }
    state.scrollY = 0;
  }

  // rerender: cheap path — rebuild shadow content in place (no body swap).
  function rerender(article, settings) {
    if (!state.active) return Promise.resolve();
    var host = document.getElementById("simpleview-root");
    if (!host || !host.shadowRoot) {
      // Lost host somehow; nothing safe to do without a full re-activate.
      return Promise.resolve();
    }
    var fonts = settings.typography === "original" ? captureOriginalFonts() : null;
    return fetchCss().then(function (cssText) {
      var shadow = host.shadowRoot;
      // Clear and rebuild.
      while (shadow.firstChild) shadow.removeChild(shadow.firstChild);
      var style = document.createElement("style");
      style.textContent = cssText || "";
      shadow.appendChild(style);
      shadow.appendChild(buildContainer(article, settings, fonts));
      // Keep the body background in sync with theme.
      if (document.body) {
        document.body.style.background = THEME_BG[settings.theme] || THEME_BG.light;
      }
    });
  }

  // showToast: works on the ORIGINAL page via its own isolated shadow host.
  function showToast(msg) {
    var host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "0";
    host.style.right = "0";
    host.style.bottom = "0";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "none";
    var shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent =
      ".sv-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);" +
      "background:#1A1A18;color:#FAF9F6;font:14px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
      "padding:10px 18px;border-radius:2px;opacity:0;transition:opacity 150ms ease;" +
      "box-shadow:0 1px 4px rgba(0,0,0,.25);max-width:80vw;text-align:center;}" +
      ".sv-toast.sv-show{opacity:1;}" +
      "@media (prefers-reduced-motion: reduce){.sv-toast{transition:none;}}";
    shadow.appendChild(style);
    var pill = document.createElement("div");
    pill.className = "sv-toast";
    pill.textContent = msg;
    shadow.appendChild(pill);
    (document.body || document.documentElement).appendChild(host);

    // Fade in.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { pill.classList.add("sv-show"); });
    });
    // Auto-dismiss after 2.5s, then fade out 150ms before removal.
    setTimeout(function () {
      pill.classList.remove("sv-show");
      setTimeout(function () {
        if (host.parentNode) host.parentNode.removeChild(host);
      }, 200);
    }, 2500);
  }

  window.__simpleView.render = {
    activate: activate,
    deactivate: deactivate,
    rerender: rerender,
    showToast: showToast,
    state: state
  };
})();
