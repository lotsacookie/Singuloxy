function unwrap_root(root) {
  if (!root || typeof root !== "object") return root;
  let target = root.__target__;
  if (target && target !== root) return target;
  return root;
}

if (typeof IntersectionObserver !== "undefined") {
  globalThis.IntersectionObserver = new Proxy(IntersectionObserver, {
    construct(target, args, new_target) {
      let options = args[1];
      if (options && typeof options === "object" && options.root) {
        let root = unwrap_root(options.root);
        if (root !== options.root) {
          args = [args[0], {...options, root: root}];
        }
      }
      return Reflect.construct(target, args, new_target);
    }
  });
}
