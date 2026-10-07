function start_safety_net() {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;

  let started = false;
  let begin = () => {
    if (started) return;
    let root = document.documentElement;
    if (!root) return;
    started = true;

    let observer = new MutationObserver((records) => {
      for (let record of records) {
        if (record.type === "childList") {
          for (let node of record.addedNodes) {
            if (node.nodeType === 1) rewrite_media_only(node);
          }
        }
        else if (record.type === "attributes" && record.target.nodeType === 1) {
          let target = record.target;
          if (!target.__media_hooked__ && target.matches(MEDIA_SELECTOR)) rewrite_media_only(target);
        }
      }
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset"]
    });
  };

  begin();
  if (!started) document.addEventListener("DOMContentLoaded", begin, {once: true});
}
