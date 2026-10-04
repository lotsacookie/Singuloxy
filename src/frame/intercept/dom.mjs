import * as rewrite from "../rewrite/index.mjs";
import { proxy_function } from "../context.mjs";

const MEDIA_TAGS = new Set(["img", "audio", "video", "source"]);

function handle_node(node) {
  if (!node) return;
  try {
    if (node instanceof DocumentFragment) {
      for (let child of [...node.children]) {
        rewrite.element(child);
      }
    }
    else if (node instanceof Element) {
      rewrite.element(node);
    }
  }
  catch (e) {
    console.error(e);
  }
}

function handle_all(nodes) {
  for (let node of nodes) {
    handle_node(node);
  }
}

function hook_first_arg(target, key) {
  proxy_function(target, key, (func, this_arg, args) => {
    handle_node(args[0]);
    return Reflect.apply(func, this_arg, args);
  });
}

function hook_all_args(target, key) {
  proxy_function(target, key, (func, this_arg, args) => {
    handle_all(args);
    return Reflect.apply(func, this_arg, args);
  });
}

function hook_html_setter(name) {
  let descriptor = Object.getOwnPropertyDescriptor(Element.prototype, name);
  if (!descriptor || !descriptor.set) return;
  Object.defineProperty(Element.prototype, name, {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: descriptor.get,
    set: function(value) {
      let scope = name === "outerHTML" ? this.parentElement : this;
      descriptor.set.call(this, value);
      handle_node(scope);
    }
  });
}

if (typeof Node !== "undefined") {
  hook_first_arg(Node.prototype, "appendChild");
  hook_first_arg(Node.prototype, "insertBefore");
  hook_first_arg(Node.prototype, "replaceChild");
}

if (typeof Element !== "undefined") {
  for (let key of ["append", "prepend", "before", "after", "replaceWith", "replaceChildren"]) {
    hook_all_args(Element.prototype, key);
  }
  proxy_function(Element.prototype, "insertAdjacentElement", (func, this_arg, args) => {
    handle_node(args[1]);
    return Reflect.apply(func, this_arg, args);
  });
  proxy_function(Element.prototype, "insertAdjacentHTML", (func, this_arg, args) => {
    let result = Reflect.apply(func, this_arg, args);
    let position = String(args[0]).toLowerCase();
    let scope = position === "beforebegin" || position === "afterend" ? this_arg.parentElement : this_arg;
    handle_node(scope);
    return result;
  });
  hook_html_setter("innerHTML");
  hook_html_setter("outerHTML");
}

if (typeof DocumentFragment !== "undefined") {
  for (let key of ["append", "prepend", "replaceChildren"]) {
    hook_all_args(DocumentFragment.prototype, key);
  }
}

if (typeof Document !== "undefined") {
  proxy_function(Document.prototype, "createElement", (func, this_arg, args) => {
    let element = Reflect.apply(func, this_arg, args);
    try {
      if (MEDIA_TAGS.has(String(args[0]).toLowerCase())) {
        rewrite.element(element);
      }
    }
    catch (e) {
      console.error(e);
    }
    return element;
  });
}

for (let name of ["Image", "Audio"]) {
  if (globalThis[name]) {
    globalThis[name] = new Proxy(globalThis[name], {
      construct(target, args) {
        let ret = Reflect.construct(target, args);
        rewrite.element(ret);
        return ret;
      }
    });
  }
}
