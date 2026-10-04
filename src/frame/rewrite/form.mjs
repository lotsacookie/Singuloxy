import { ctx, convert_url } from "../context.mjs";
import * as loader from "../loader.mjs";

function build_request(form_element) {
  let method = (form_element.getAttribute("method") || "get").toLowerCase();
  let action = form_element.getAttribute("action");
  if (!action) action = ctx.location.href;
  let target_url = convert_url(action, ctx.location.href);

  let form_data = new FormData(form_element);

  if (method === "post") {
    let enctype = form_element.getAttribute("enctype") || "application/x-www-form-urlencoded";
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
  for (let [key, value] of form_data.entries()) {
    if (typeof value === "string") url_obj.searchParams.set(key, value);
  }
  return { url: url_obj.href, form_data: null };
}

function perform_submit(form_element) {
  let { url, form_data } = build_request(form_element);
  loader.navigate(loader.frame_id, url, true, form_data);
}

export function rewrite_form(form_element) {
  form_element.addEventListener("submit", (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    perform_submit(form_element);
  });

  form_element.submit = () => {
    perform_submit(form_element);
  };
}
