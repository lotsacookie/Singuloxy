import * as meriyah from "meriyah";
import * as astray from "astray";
import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import * as parser from "../parser.mjs";
import { ctx, convert_url } from "../context.mjs";

const module_cache = new Map();
const loading_stack = new Set();

const STUB_MODULE_SRC = "/* sandstone: circular import stub, see console warning */\nexport default undefined;\n";

function make_blob_url(js_text) {
  let blob = new Blob([js_text], { type: "text/javascript" });
  return URL.createObjectURL(blob);
}

class ImportVisitor {
  constructor() {
    this.records = [];
    this.ImportDeclaration = this.ImportDeclaration.bind(this);
    this.ExportNamedDeclaration = this.ExportNamedDeclaration.bind(this);
    this.ExportAllDeclaration = this.ExportAllDeclaration.bind(this);
    this.MemberExpression = this.MemberExpression.bind(this);
  }

  record_source(node) {
    if (!node.source) return;
    this.records.push({
      type: "static",
      start: node.source.start,
      end: node.source.end,
      specifier: node.source.value
    });
  }

  ImportDeclaration(node) { this.record_source(node); }
  ExportNamedDeclaration(node) { this.record_source(node); }
  ExportAllDeclaration(node) { this.record_source(node); }

  MemberExpression(node) {
    let obj = node.object;
    let is_import_meta = obj && obj.type === "MetaProperty"
      && obj.meta?.name === "import" && obj.property?.name === "meta";
    if (is_import_meta && !node.computed && node.property?.name === "url") {
      this.records.push({ type: "import_meta_url", start: node.start, end: node.end });
    }
  }
}

function find_module_imports(js) {
  let ast;
  try {
    ast = meriyah.parse(js, { ranges: true, webcompat: true, module: true });
  }
  catch (e) {
    console.error("sandstone: module parse error", e);
    return [];
  }
  let visitor = new ImportVisitor();
  astray.walk(ast, visitor);
  return visitor.records;
}

function apply_splices(js, splices) {
  let sorted = [...splices].sort((a, b) => a.start - b.start);
  let out = "";
  let prev = 0;
  for (let splice of sorted) {
    out += js.substring(prev, splice.start);
    out += splice.replacement;
    prev = splice.end;
  }
  out += js.substring(prev);
  return out;
}

async function resolve_and_rewrite(js, base_url) {
  let records = find_module_imports(js);
  let splices = [];

  for (let record of records) {
    if (record.type === "import_meta_url") {
      splices.push({ start: record.start, end: record.end, replacement: JSON.stringify(base_url) });
      continue;
    }

    let absolute = convert_url(record.specifier, base_url);
    let blob_url;
    if (loading_stack.has(absolute)) {
      console.warn("sandstone: circular ES module import detected, using an empty stub for this edge:", absolute);
      blob_url = make_blob_url(STUB_MODULE_SRC);
    }
    else {
      blob_url = await load_module(absolute, absolute);
    }
    splices.push({ start: record.start, end: record.end, replacement: JSON.stringify(blob_url) });
  }

  let with_imports_rewritten = apply_splices(js, splices);
  return parser.rewrite_js(with_imports_rewritten, true);
}

export async function load_module(cache_key, base_url, source_text = null) {
  if (module_cache.has(cache_key)) {
    return module_cache.get(cache_key);
  }

  let promise = (async () => {
    loading_stack.add(cache_key);
    try {
      let js = source_text;
      if (js === null) {
        let response = await network.fetch(base_url);
        js = await response.text();
      }
      let rewritten = await resolve_and_rewrite(js, base_url);
      return make_blob_url(rewritten);
    }
    finally {
      loading_stack.delete(cache_key);
    }
  })();

  module_cache.set(cache_key, promise);
  return promise;
}

export async function dynamic_import(specifier) {
  let absolute = convert_url(specifier, ctx.location.href);
  let blob_url = loading_stack.has(absolute)
    ? make_blob_url(STUB_MODULE_SRC)
    : await load_module(absolute, absolute);
  return import(/* webpackIgnore: true */ blob_url);
}

export async function rewrite_module_script(script_element) {
  if (!loader.site_settings.allow_js) return;

  let script_url = script_element.getAttribute("src");
  let inline_text = script_element.innerHTML;
  script_element.removeAttribute("src");

  let is_inline = !script_url;
  let base_url = script_url ? convert_url(script_url, ctx.location.href) : ctx.location.href;
  let cache_key = is_inline ? Symbol("inline-module") : base_url;

  let blob_url;
  try {
    blob_url = await load_module(cache_key, base_url, is_inline ? inline_text : null);
  }
  catch (e) {
    console.error("sandstone: failed to load module script", base_url, e);
    return;
  }

  script_element.innerHTML = "";
  script_element.type = "module";
  script_element.src = blob_url;
  }
