import { proxy_function } from "../context.mjs";

const SIGNAL_ERROR = /AbortSignal/;
let warned = 0;

function looks_like_signal(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function";
}

function is_signal_error(e) {
  return e !== null
    && typeof e === "object"
    && e.name === "TypeError"
    && SIGNAL_ERROR.test(String(e.message));
}

function warn(method, signal) {
  if (warned >= 5) return;
  warned++;
  console.warn("sandstone: invalid AbortSignal passed to " + method, signal, new Error().stack);
}

function strip_signal(options) {
  let copy = {...options};
  delete copy.signal;
  return copy;
}

function install() {
  if (typeof EventTarget === "undefined") return;

  proxy_function(EventTarget.prototype, "addEventListener", (func, this_arg, args) => {
    try {
      return Reflect.apply(func, this_arg, args);
    }
    catch (e) {
      let options = args[2];
      if (!is_signal_error(e) || options === null || typeof options !== "object") throw e;

      let signal = options.signal;
      warn("addEventListener", signal);
      let rest = strip_signal(options);

      if (looks_like_signal(signal)) {
        if (signal.aborted) return;
        Reflect.apply(func, this_arg, [args[0], args[1], rest]);
        signal.addEventListener("abort", () => {
          try {
            this_arg.removeEventListener(args[0], args[1], rest);
          }
          catch {}
        }, {once: true});
        return;
      }

      return Reflect.apply(func, this_arg, [args[0], args[1], rest]);
    }
  });
}

install();
