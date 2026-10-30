chrome.runtime.onInstalled.addListener(function(details) {
  if (details.reason === "install") {
    // Was wrapped in chrome.storage.local.set({ installed: true }, callback)
    // — the `installed` key was never read anywhere in the codebase, and the
    // callback wrapper was only used to sequence the tab open. MV3 set()
    // returns a Promise so we don't need it; the tab open is independent.
    chrome.tabs.create({ url: "https://wallsflow.com/extension/index.html" });
  } else if (details.reason === "update") {
    // Open the internal "What's new" page when the extension actually
    // bumps version (skip Chrome-internal re-installs that fire 'update'
    // with the same version).
    var previous = details.previousVersion;
    var current = chrome.runtime.getManifest().version;
    if (previous && previous !== current) {
      var url = chrome.runtime.getURL("src/html/whats-new.html")
        + "?from=" + encodeURIComponent(previous)
        + "&to=" + encodeURIComponent(current);
      chrome.tabs.create({ url: url });
    }
  }
});

// chrome.runtime.setUninstallURL has been part of MV2/MV3 since Chrome 41;
// the typeof guard previously here was always true for MV3 minimum browsers.
chrome.runtime.setUninstallURL('https://wallsflow.com/extension/uninstall.html');
