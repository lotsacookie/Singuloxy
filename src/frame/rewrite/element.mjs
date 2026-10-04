import * as rewrite from "./index.mjs";

import { parse_css } from "./css.mjs";
import { ctx, run_script } from "../context.mjs";

function is_stylesheet_link(element) {
  if (!(element instanceof HTMLLinkElement)) return false;
  return element.relList.contains("stylesheet") && !element.relList.contains("alternate");
}

function rewrite_element_single(element) {
  let promise;
  if (element.tagName === "NOSCRIPT")
    promise = rewrite.noscript(element);
  else if (element.matches("img, source, video, audio, input[type='image']"))
    promise = rewrite.media(element);
  else if (element instanceof HTMLLinkElement && !is_stylesheet_link(element))
    promise = rewrite.link(element);
  else if (element instanceof HTMLMetaElement)
    promise = rewrite.meta(element);
  else if (is_stylesheet_link(element))
    promise = rewrite.stylesheet(element);
  else if (element instanceof HTMLStyleElement)
    promise = rewrite.style(element);
  else if (element instanceof HTMLScriptElement) {
    let script_type = (element.getAttribute("type") || "").trim().toLowerCase();
    if (element.hasAttribute("nomodule")) {}
    else if (script_type === "importmap")
      promise = rewrite.import_map(element);
    else if (script_type === "module")
      promise = rewrite.module_script(element);
    else
      promise = rewrite.script(element);
  }
  else if (element instanceof HTMLFormElement)
    promise = rewrite.form(element);
  else if (element instanceof HTMLIFrameElement)
    promise = rewrite.iframe(element);
  let promises = [promise];

  for (let j = 0; j < element.attributes.length; j++) {
    let attribute = element.attributes[j].name;
    if (!attribute.startsWith("on")) continue;
    let handler_script = element.getAttribute(attribute);
    let event_name = attribute.substring(2);

    element.setAttribute("__" + attribute, handler_script);
    element.removeAttribute(attribute);
    element.addEventListener(event_name, () => {
      run_script(handler_script, element);
    });
  }

  let inline_style = element.getAttribute("style");
  if (inline_style) {
    element.style.cssText = "";
    let new_css = parse_css(inline_style, ctx.location.href)
    if (typeof new_css === "string") {
      element.style.cssText = new_css;
    }
    else {
      promises.push((async () => {
        element.style.cssText = await new_css;
      })());
    }
  }

  element.addEventListener("focus", () => {
    ctx.document.activeElement = element;
  })

  return promises;
}

export function rewrite_element(element) {
  if (!(element instanceof Element))
    return;

  let promises = [];
  if (!element.__rewritten__) {
    element.__rewritten__ = true;
    promises = rewrite_element_single(element);
  }
  
  let children = [...element.children];
  for (let child of children) {
    promises.push(rewrite_element(child));
  }

  promises = promises.filter((promise) => promise).map((promise) => {
    return Promise.resolve(promise).catch((e) => {
      console.error("sandstone: element rewrite failed", e);
    });
  });
  if (promises.length === 0)
    return undefined;
  return Promise.all(promises);
}
