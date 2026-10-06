import { ctx_vars, unreadable_vars } from "./context.mjs";

import * as meriyah from "meriyah";
import * as astray from 'astray';

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

const script_parse_attempts = [
  {webcompat: true},
  {webcompat: true, next: true, globalReturn: true, specDeviation: true},
  {webcompat: true, next: true, module: true}
];

const module_parse_attempts = [
  {webcompat: true, next: true, module: true}
];

const MAX_VALIDATE_LENGTH = 8 * 1024 * 1024;
const MODULE_SYNTAX = /(^|[\n;{}])\s*(import\s*[\w{*"']|export\s+[\w{*])/;

function parse_js(js, is_module) {
  let attempts = is_module ? module_parse_attempts : script_parse_attempts;
  let errors = [];

  for (let options of attempts) {
    try {
      return meriyah.parse(js, {ranges: true, ...options});
    }
    catch (e) {
      errors.push(e);
    }
  }

  let last_error = errors[errors.length - 1];
  try {
    last_error.attempt_errors = errors;
  }
  catch {}
  throw last_error;
}

function can_parse(js, is_module) {
  let attempts = is_module ? module_parse_attempts : script_parse_attempts;
  for (let options of attempts) {
    try {
      meriyah.parse(js, options);
      return true;
    }
    catch {}
  }
  return false;
}

function position_of(js, line, column) {
  let position = 0;
  let current = 1;
  while (current < line) {
    let next = js.indexOf("\n", position);
    if (next === -1) break;
    position = next + 1;
    current++;
  }
  return position + column;
}

function locate_error(js, e) {
  if (typeof e?.index === "number") return e.index;
  if (typeof e?.start === "number") return e.start;
  if (typeof e?.line === "number" && typeof e?.column === "number") {
    return position_of(js, e.line, e.column);
  }
  let match = /\[(\d+):(\d+)/.exec(String(e?.message ?? ""));
  if (match) return position_of(js, Number(match[1]), Number(match[2]));
  return null;
}

function describe_error(js, e) {
  let message = String(e?.message ?? e);
  let index = locate_error(js, e);
  if (index === null || !Number.isFinite(index)) return message;
  let start = Math.max(0, index - 70);
  let snippet = js.slice(start, index + 70).replace(/\s+/g, " ");
  return `${message} (offset ${index} of ${js.length}) near: ${snippet}`;
}

function browser_can_parse(js) {
  if (js.length > MAX_VALIDATE_LENGTH) return null;
  if (MODULE_SYNTAX.test(js)) return null;
  try {
    new AsyncFunction(js);
    return true;
  }
  catch (e) {
    return e instanceof SyntaxError ? false : null;
  }
}

function is_non_reference(node, parent) {
  switch (parent.type) {
    case "UpdateExpression":
    case "RestElement":
    case "ArrayPattern":
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportSpecifier":
      return true;
    case "CatchClause":
      return parent.param === node;
    case "ClassDeclaration":
    case "ClassExpression":
      return parent.id === node;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return parent.label === node;
    case "ForInStatement":
    case "ForOfStatement":
      return parent.left === node;
    case "PropertyDefinition":
      return parent.key === node && !parent.computed;
    case "MemberExpression":
      return parent.property === node && !parent.computed;
    default:
      return false;
  }
}

class ASTVisitor {
  constructor(ast) {
    this.ast = ast;
    this.rewrites = [];
    this.block_depth = 0;
    this.function_depth = 0;
    this.for_init = false;

    this.ThisExpression = this.ThisExpression.bind(this);
    this.Identifier = this.Identifier.bind(this);
    this.BlockStatement = this.BlockStatement.bind(this);
    this.ImportExpression = this.ImportExpression.bind(this);
  }

  ThisExpression(node) {
    let parentheses = false;
    let parent_node = node;
    while (parent_node) {
      if (parent_node.type === "NewExpression") {
        parentheses = true;
        break;
      }
      parent_node = parent_node.path.parent;
    }
    this.rewrites.push({type: "this", pos: node.start, parentheses: parentheses});
  }

  Identifier(node) {
    let parent = node.path.parent;
    if (!parent) 
      return;
    if (is_non_reference(node, parent))
      return;
    if (parent.type === "VariableDeclarator" && parent.id === node)
      return;

    if (parent.type === "Property") {
      if (parent.shorthand || (parent.key === node && !parent.computed))
        return;
      if (parent.path?.parent?.type !== "ObjectExpression")
        return;
    }
    else if (parent.type === "ArrowFunctionExpression") {
      if (parent.body !== node) return;
    }
    else if (parent.type === "AssignmentPattern") {
      if (parent.right !== node) return;
    }
    else if (
      parent.type === "FunctionDeclaration" ||
      parent.type === "FunctionExpression" ||
      parent.type === "MethodDefinition"
    ) {
      return;
    }

    if (!ctx_vars.includes(node.name)) 
      return;

    let simple = false;
    if (parent.type === "AssignmentExpression" && parent.left === node) {
      if (node.name !== "location")
        return;
      simple = true;
    }
    this.rewrites.push({type: "global", pos: node.start, name: node.name, simple: simple});
  }

  ImportExpression(node) {
    this.rewrites.push({type: "dynamic_import", pos: node.start});
  }

  BlockStatement(node) {
    let first_node = node.body[0];
    if (!first_node) 
      return;

    if (first_node.type === "ExpressionStatement" && first_node.directive === "use asm") {
      return astray.SKIP;
    }
  }
}

function gen_rewrite_code(rewrite) {
  if (rewrite.type === "this") {
    let replacement = `__get_this__(this)`;
    if (rewrite.parentheses)
      replacement = `(${replacement})`;
    return [replacement, rewrite.pos + 4];
  }
  else if (rewrite.type === "global") {
    let replacement;
    if (rewrite.simple || unreadable_vars.includes(rewrite.name)) 
      replacement = `__ctx__.${rewrite.name}`;
    else 
      replacement  = `(__get_var__(${rewrite.name}, "${rewrite.name}"))`;
    return [replacement, rewrite.pos + rewrite.name.length];
  }
  else if (rewrite.type === "dynamic_import") {
    return ["__dynamic_import__", rewrite.pos + 6];
  }
  else if (rewrite.type === "delete") {
    let length = rewrite.end - rewrite.pos;
    return ["", rewrite.pos + length];
  }
  throw new Error("invalid rewrite type");
}

export function rewrite_js(js, is_module = false, label = "") {
  let ast;
  try {
    ast = parse_js(js, is_module);
  }
  catch (e) {
    let errors = Array.isArray(e?.attempt_errors) ? e.attempt_errors : [e];
    let details = errors.map((error, i) => `attempt ${i + 1}: ${describe_error(js, error)}`).join(" | ");
    let verdict = "";
    if (!is_module) {
      let browser_ok = browser_can_parse(js);
      if (browser_ok === false) {
        verdict = " The browser cannot parse this script either, so the download is probably truncated or corrupted.";
      }
      else if (browser_ok === true) {
        verdict = " The browser accepts this script, so this is a parser limitation.";
      }
    }
    console.error(`sandstone: JS parse error, script left UNREWRITTEN (it will bypass the proxy): ${label || "(inline or unnamed script)"}, ${js.length} chars. ${details}.${verdict}`);
    return js;
  }
  let ast_visitor = new ASTVisitor(ast);
  astray.walk(ast, ast_visitor);
  ast_visitor.rewrites.sort((a, b) => a.pos - b.pos);

  let rewritten_js = "";
  let prev_offset = 0;
  for (let rewrite of ast_visitor.rewrites) {
    rewritten_js += js.substring(prev_offset, rewrite.pos);
    let [replacement, offset] = gen_rewrite_code(rewrite);
    rewritten_js += replacement;
    prev_offset = offset;
  }
  rewritten_js += js.substring(prev_offset);

  let result = rewritten_js || js;
  if (ast_visitor.rewrites.length > 0 && js.length <= MAX_VALIDATE_LENGTH && !can_parse(result, is_module)) {
    console.warn(`sandstone: rewriting produced invalid JS, script left UNREWRITTEN (it will bypass the proxy): ${label || "(inline or unnamed script)"}`);
    return js;
  }
  return result;
}
