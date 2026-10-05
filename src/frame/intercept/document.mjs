import { ctx, get_handler_keys, create_obj_proxy, get_cookie_jar } from "../context.mjs";

const internal = {
  currentScript: null
}

class CustomDocument {
  constructor() {
    let keys = get_handler_keys(this);
    if (globalThis.document) {
      this.__proxy__ = create_obj_proxy(this, keys, globalThis.document);
      this.__target__ = globalThis.document;
    }   
  }

  get cookie() {return get_cookie_jar().get()}
  set cookie(value) {get_cookie_jar().set(String(value))}
  get body() {return this.__target__.body}
  get location() {return ctx.location}
  get URL() {return ctx.location.href}
  get baseURI() {return ctx.location.href}
  get documentURI() {return ctx.location.href}
  get defaultView() {return ctx.window}
  get currentScript() {return internal.currentScript}
  set currentScript(value) {internal.currentScript = value}
  get activeElement() {return this.__target__.activeElement || this.__target__.body}
  set activeElement(value) {}

  createElement(tag_name, options) {
    return this.__target__.createElement(tag_name, options);
  }

  createTreeWalker(root, whatToShow, filter) {
    if (root === this) root = document.documentElement;
    return this.__target__.createTreeWalker(root, whatToShow, filter);
  }
}

export const custom_document = new CustomDocument();
