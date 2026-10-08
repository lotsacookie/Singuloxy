function indexeddb_denied() {
  try {
    if (typeof indexedDB === "undefined" || !indexedDB) return true;
    indexedDB.deleteDatabase("__sandstone_probe__");
    return false;
  }
  catch {
    return true;
  }
}

function failing_request() {
  let request = new EventTarget();
  request.onerror = null;
  request.onsuccess = null;
  request.onupgradeneeded = null;
  request.onblocked = null;
  request.readyState = "done";
  request.result = undefined;
  request.source = null;
  request.transaction = null;
  request.error = new DOMException("IndexedDB is not available in this sandbox", "UnknownError");

  request.addEventListener("error", (event) => {
    if (typeof request.onerror === "function") request.onerror(event);
  });
  setTimeout(() => {
    request.dispatchEvent(new Event("error", {cancelable: true}));
  }, 0);
  return request;
}

function install_indexed_db_fallback() {
  if (typeof globalThis.document === "undefined") return;
  if (!indexeddb_denied()) return;

  let factory = {
    open: () => failing_request(),
    deleteDatabase: () => failing_request(),
    databases: () => Promise.resolve([]),
    cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  };
  try {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      enumerable: true,
      get: () => factory
    });
  }
  catch {}
}

install_indexed_db_fallback();
