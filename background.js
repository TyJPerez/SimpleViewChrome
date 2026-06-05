// SimpleView — MV3 service worker (background.js)
// Responsibilities (ARCHITECTURE §7):
//   - On toolbar icon click, send SV_TOGGLE to the active tab and reflect the result
//     in a per-tab badge.
//   - Maintain the per-tab badge in response to SV_STATE / SV_NO_ARTICLE messages.
//   - Seed default settings on install.
// Service-worker-safe: no window/document, no external dependencies.

"use strict";

// Accent badge color (ARCHITECTURE §7 / SPEC §1.1).
const BADGE_COLOR = "#2F6B4F";
const NO_ARTICLE_FLASH_MS = 1500;

// NOTE: This MUST stay in sync with the DEFAULT_SETTINGS in content/settings.js
// (and the duplicate in options/options.js). Verbatim copy of ARCHITECTURE §4.
const DEFAULT_SETTINGS = {
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

// --- Badge helpers (always per-tab; never set a global badge) ----------------

// Apply the badge text + accent colors for a specific tab. All calls are guarded
// so a closed/navigated-away tab never throws.
function setBadge(tabId, text) {
  if (typeof tabId !== "number") return;

  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});

  // setBadgeTextColor is not available in older Chrome — guard it.
  try {
    if (chrome.action.setBadgeTextColor) {
      chrome.action.setBadgeTextColor({ tabId, color: "#FFFFFF" }).catch(() => {});
    }
  } catch (_) {
    /* older Chrome: text color unsupported, ignore */
  }
}

function clearBadge(tabId) {
  if (typeof tabId !== "number") return;
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
}

// --- Toolbar icon click ------------------------------------------------------
// Toggle the current tab; reflect {active, ok} in the badge. Silently no-op on
// pages where the content script isn't present (chrome://, Web Store, PDFs, etc.).
chrome.action.onClicked.addListener((tab) => {
  if (!tab || typeof tab.id !== "number") return;

  chrome.tabs
    .sendMessage(tab.id, { type: "SV_TOGGLE" })
    .then((resp) => {
      if (!resp) return; // no/empty response: leave badge as-is
      // No extractable article (ok===false): do NOT flash here. The content side
      // emits SV_NO_ARTICLE, which is the single source of truth for the "!" flash
      // — flashing here too would start a second overlapping timer. Still reflect
      // resp.active in the badge as usual.
      setBadge(tab.id, resp.active ? "ON" : "");
    })
    .catch(() => {
      // Unsendable page (no content script) — no-op silently.
    });
});

// --- No-article flash ("!") --------------------------------------------------
function flashNoArticle(tabId) {
  if (typeof tabId !== "number") return;
  setBadge(tabId, "!");
  // Best-effort clear after ~1.5s. In MV3 the service worker can be terminated
  // before this fires, which would rarely leave the "!" lingering; it self-corrects
  // on the next badge event (SV_STATE / next toggle). Guard the clear in case the
  // tab closed.
  setTimeout(() => clearBadge(tabId), NO_ARTICLE_FLASH_MS);
}

// --- Messages from content scripts -------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "SV_STATE":
      setBadge(tabId, msg.active ? "ON" : "");
      break;
    case "SV_NO_ARTICLE":
      flashNoArticle(tabId);
      break;
    default:
      break;
  }
  // No async response needed; return undefined (don't hold the channel open).
});

// --- Install: seed default settings if absent --------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get("settings").then((data) => {
    if (data && data.settings === undefined) {
      chrome.storage.sync.set({ settings: DEFAULT_SETTINGS }).catch(() => {});
    }
  }).catch(() => {});
});
