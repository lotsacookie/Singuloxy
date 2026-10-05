import { rewrite_js } from "../parser.mjs";

const NativeFunction = Function;

Function.prototype.__toString = Function.prototype.toString;
Function.prototype.toString = function() {
  let js = this.__toString();
  js = js.replaceAll("__ctx__.", "");
  js = js.replaceAll("__get_this__(this)", "this");
  js = js.replace(/\(__get_var__\(([A-Za-z_$][\w$]*), "([A-Za-z_$][\w$]*)"\)\)/g, (match, name, quoted) => {
    return name === quoted ? name : match;
  });
  return js;
}

function build_function(args) {
  if (args.length === 0) return NativeFunction();
  let params = args.slice(0, -1);
  let body = String(args[args.length - 1]);
  let rewritten = body;
  try {
    rewritten = rewrite_js(body);
  }
  catch {
    rewritten = body;
  }
  return NativeFunction(...params, rewritten);
}

const FunctionProxy = new Proxy(NativeFunction, {
  apply: (target, this_arg, args) => build_function(args),
  construct: (target, args) => build_function(args)
});

globalThis.Function = FunctionProxy;
NativeFunction.prototype.constructor = FunctionProxy;
