import { ctx, convert_url } from "../context.mjs";
import * as loader from "../loader.mjs";

function build_form_data(form_element, submitter) {
  try {
    if (submitter) return new FormData(form_element, submitter);
  }
  catch {}
  return new FormData(form_element);
}

function build_request(form_element, submitter) {
  let method = (
    (submitter && submitter.getAttribute("formmethod")) ||
    form_element.getAttribute("method") ||
    "get"
  ).toLowerCase();
  let action = (submitter && submitter.getAttribute("formaction")) || form_element.getAttribute("action");
  if (!action) action = ctx.location.href;
  let target_url = convert_url(action, ctx.location.href);

  let form_data = build_form_data(form_element, submitter);

  if (method === "post") {
    let enctype = (
      (submitter && submitter.getAttribute("formenctype")) ||
      form_element.getAttribute("enctype") ||
      "application/x-www-form-urlencoded"
    ).toLowerCase();
    let body;

    if (enctype === "multipart/form-data") {
      body = [...form_data.entries()];
    }
    else {
      let params = new URLSearchParams();
      for (let [key, value] of form_data.entries()) {
        if (typeof value === "string") params.append(key, value);
      }
      body = params.toString();
      if (enctype !== "text/plain") enctype = "application/x-www-form-urlencoded";
    }

    return {
      url: target_url,
      form_data: { method: "post", enctype, body }
    };
  }

  let url_obj = new URL(target_url);
  let params = new URLSearchParams();
  for (let [key, value] of form_data.entries()) {
    if (typeof value === "string") params.append(key, value);
  }
  url_obj.search = params.toString();
  return { url: url_obj.href, form_data: null };
}

function perform_submit(form_element, submitter) {
  let { url, form_data } = build_request(form_element, submitter);
  loader.navigate(loader.frame_id, url, true, form_data);
}

export function rewrite_form(form_element) {
  form_element.addEventListener("submit", (event) => {
    if (event.defaultPrevented) return;
    let method = (
      (event.submitter && event.submitter.getAttribute("formmethod")) ||
      form_element.getAttribute("method") ||
      "get"
    ).toLowerCase();
    if (method === "dialog") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    perform_submit(form_element, event.submitter);
  });

  form_element.submit = () => {
    perform_submit(form_element, null);
  };
}
