// content/main.js — entry point: message handling, auto-apply, live re-render.
// Classic script; shares scope via window.__simpleView. Guarded against
// double-injection.
(function () {
  "use strict";

  window.__simpleView = window.__simpleView || {};
  if (window.__simpleView.__mainLoaded) return;
  window.__simpleView.__mainLoaded = true;

  var SV = window.__simpleView;

  // Module-level latch: true while a toggle (activate or deactivate) is in
  // flight, so a second SV_TOGGLE can't overlap the first and race the body
  // swap (see render.js activate()).
  var busy = false;

  // URL captured at activation; SPA navigation away from it restores the
  // original (SPEC §6). null while inactive.
  var activeUrl = null;

  function sendState(active) {
    try {
      chrome.runtime.sendMessage({ type: "SV_STATE", active: active });
    } catch (e) { /* ignore unsendable */ }
  }

  function isReaderable() {
    try {
      return typeof isProbablyReaderable === "function" && isProbablyReaderable(document);
    } catch (e) {
      return false;
    }
  }

  // Tear down active state: deactivate + drop navigation tracking + notify.
  function deactivateAndNotify() {
    SV.render.deactivate();
    removeNavWatch();
    activeUrl = null;
    sendState(false);
  }

  // ---- SPA navigation handling (SPEC §6) ---------------------------------
  // While Simple View is active, an in-page navigation must restore the
  // original first. We listen for popstate/hashchange and a synthetic
  // "sv:locationchange" dispatched from patched history.pushState/replaceState.
  var navListening = false;
  var historyPatched = false;

  function onLocationChange() {
    // Inert unless active (the history patch stays installed but guarded).
    if (!navListening) return;
    if (!SV.state || !SV.state.active) return;
    if (activeUrl !== null && location.href === activeUrl) return; // no real change
    deactivateAndNotify();
  }

  function patchHistory() {
    if (historyPatched) return;
    historyPatched = true;
    try {
      ["pushState", "replaceState"].forEach(function (name) {
        var orig = history[name];
        if (typeof orig !== "function") return;
        history[name] = function () {
          var ret = orig.apply(this, arguments);
          try { window.dispatchEvent(new Event("sv:locationchange")); } catch (e) { /* ignore */ }
          return ret;
        };
      });
    } catch (e) { /* leave history as-is on failure */ }
  }

  function installNavWatch() {
    activeUrl = location.href;
    patchHistory(); // idempotent; handler is guarded on state.active
    if (navListening) return;
    navListening = true;
    window.addEventListener("popstate", onLocationChange);
    window.addEventListener("hashchange", onLocationChange);
    window.addEventListener("sv:locationchange", onLocationChange);
  }

  function removeNavWatch() {
    if (!navListening) return;
    navListening = false;
    window.removeEventListener("popstate", onLocationChange);
    window.removeEventListener("hashchange", onLocationChange);
    window.removeEventListener("sv:locationchange", onLocationChange);
  }

  // ---- Message handling --------------------------------------------------
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== "SV_TOGGLE") return;

    // Serialize: a second toggle while one is in flight is a no-op that just
    // reports current state, so the two can't overlap and race the body swap.
    if (busy) {
      sendResponse({ active: !!(SV.state && SV.state.active), ok: true });
      return; // synchronous response
    }

    if (SV.state && SV.state.active) {
      deactivateAndNotify();
      sendResponse({ active: false, ok: true });
      return; // synchronous response
    }

    // Activate path is async (settings load + css fetch).
    busy = true;
    SV.settings.load().then(function (settings) {
      var article = null;
      try {
        article = SV.extract(settings);
      } catch (e) {
        article = null;
      }
      if (!article) {
        busy = false;
        SV.render.showToast("No article found on this page");
        try { chrome.runtime.sendMessage({ type: "SV_NO_ARTICLE" }); } catch (e2) { /* ignore */ }
        sendResponse({ active: false, ok: false });
        return;
      }
      SV.render.activate(article, settings).then(function () {
        // Stash the last-rendered article for live re-render on settings change.
        SV.__lastArticle = article;
        installNavWatch();
        busy = false;
        sendState(true);
        sendResponse({ active: true, ok: true });
      }).catch(function () {
        // Render failed; page is left untouched by activate's own guards.
        busy = false;
        SV.render.showToast("No article found on this page");
        try { chrome.runtime.sendMessage({ type: "SV_NO_ARTICLE" }); } catch (e3) { /* ignore */ }
        sendResponse({ active: false, ok: false });
      });
    }).catch(function () {
      busy = false;
      sendResponse({ active: false, ok: false });
    });

    return true; // responding asynchronously
  });

  // ---- Auto-apply on load ------------------------------------------------
  function autoApply() {
    SV.settings.load().then(function (settings) {
      if (!SV.settings.matchesSiteList(location.href, settings.autoSites)) return;
      if (!isReaderable()) return;
      var article = null;
      try {
        article = SV.extract(settings);
      } catch (e) {
        return; // silent skip
      }
      if (!article) return;
      SV.render.activate(article, settings).then(function () {
        SV.__lastArticle = article;
        // Restore-on-SPA-nav applies to auto-applied views too. Auto-apply
        // itself stays load-time only (it does not re-trigger on route change).
        installNavWatch();
        sendState(true);
      }).catch(function () { /* silent skip, no toast */ });
    }).catch(function () { /* silent */ });
  }
  autoApply();

  // ---- Live re-render on settings change --------------------------------
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "sync" || !changes || !changes.settings) return;
    if (!SV.state || !SV.state.active) return;
    SV.settings.load().then(function (settings) {
      var article = null;
      try {
        article = SV.extract(settings);
      } catch (e) {
        article = null;
      }
      // Fall back to the last good article if re-extraction fails (the original
      // body is detached, so isProbablyReaderable would now fail).
      if (!article) article = SV.__lastArticle;
      if (!article) return;
      SV.__lastArticle = article;
      SV.render.rerender(article, settings);
    }).catch(function () { /* ignore */ });
  });
})();
