chrome.webRequest.onBeforeRequest.addListener(
  (details) => globalThis.__chromecraftNetworkObserver?.emit(details),
  { urls: ["<all_urls>"] },
);
