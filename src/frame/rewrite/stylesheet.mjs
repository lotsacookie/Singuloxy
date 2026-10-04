import * as network from "../network.mjs";
import { ctx, convert_url } from "../context.mjs";
import { parse_css } from "./css.mjs";

export async function rewrite_stylesheet(link_element) {
  if (link_element.hasAttribute("integrity")) 
    link_element.removeAttribute("integrity");

  let link_href = link_element.getAttribute("href") || link_element.getAttribute("data-href");
  if (!link_href) {
    return;
  }

  let css_url = convert_url(link_href, ctx.location.href);
  let css, response;
  try {
    response = await network.fetch(css_url);
    css = await response.text();  
  }
  catch (e) {
    console.error("sandstone: failed to load stylesheet", css_url, e);
    css = "";
  }
  let new_css = await parse_css(css, response?.url || css_url);
  let css_blob = new Blob([new_css], {type: "text/css"});
  link_element.href = network.create_blob_url(css_blob, response?.url || css_url);
}
