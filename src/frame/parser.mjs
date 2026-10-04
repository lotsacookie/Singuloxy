import { ctx_vars, unreadable_vars } from "./context.mjs";

import * as meriyah from "meriyah";
import * as astray from 'astray';

const script_parse_attempts = [
  {webcompat: true},
  {webcompat: true, next: true, globalReturn: true, specDeviation: true},
  {webcompat: true, next: true, module: true}
];

const module_parse_attempts = [
  {webcompat: true, next: true, module: true}
];

function parse_js(js, is_module) {
  let attempts = is_module ? module_parse_attempts : script_parse_attempts;
  let last_error;

  for (let options of attempts) {
    try {
      return meriyah.parse(js, {ranges: true, ...options});
    }
    catch (e) {
      last_error = e;
    }
  }

  throw last_error;
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
    if (parent.type === "MemberExpression" && parent.start !== node.start) 
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

export function rewrite_js(js, is_module = false) {
  let ast;
  try {
    ast = parse_js(js, is_module);
  }
  catch (e) {
    console.error("sandstone: JS parse error, script left UNREWRITTEN (it will bypass the proxy):", e?.message ?? e);
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
  
  return rewritten_js || js;
}
