"use strict";
// JavaScript implementation of PKM stateless core components.
// Protocol: one JSON request on stdin, one JSON response on stdout.
// Request: {component, inputs, context: {workspace, resolved_path?, float_inputs?}}
// Response: {ok: true, output, float_fields} | {ok: false, error: {type, message}}

const fs = require("fs");
const os = require("os");
const path = require("path");

const SAFE = Number.MAX_SAFE_INTEGER;
const VALUE_TYPES = ["string", "integer", "number", "boolean", "object", "array", "null"];

class ComponentError extends Error {
  constructor(type, message) { super(message); this.type = type; }
}
const valueError = message => new ComponentError("ValueError", message);

function num(v, f) { return { v, f }; }

function pyFloatRepr(value) {
  if (Object.is(value, -0)) return "-0.0";
  const [mantissa, exponentText] = value.toExponential().split("e");
  const exponent = Number(exponentText);
  const digits = mantissa.replace("-", "").replace(".", "");
  const sign = value < 0 ? "-" : "";
  if (exponent < -4 || exponent >= 16) {
    const body = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
    return sign + body + "e" + (exponent < 0 ? "-" : "+") + String(Math.abs(exponent)).padStart(2, "0");
  }
  if (exponent < 0) return sign + "0." + "0".repeat(-exponent - 1) + digits;
  const whole = digits.padEnd(exponent + 1, "0");
  const fraction = digits.slice(exponent + 1);
  return sign + whole.slice(0, exponent + 1) + "." + (fraction || "0");
}

function pyDumps(value, isFloat) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw valueError("Out of range float values are not JSON compliant");
    return isFloat ? pyFloatRepr(value) : String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(item => pyDumps(item, false)).join(", ") + "]";
  return "{" + Object.entries(value).map(([key, item]) => JSON.stringify(key) + ": " + pyDumps(item, false)).join(", ") + "}";
}

function castValue(value, targetType, trim, valueIsFloat) {
  if (!VALUE_TYPES.includes(targetType) || typeof trim !== "boolean") {
    throw valueError("Choose a supported Cast target type and boolean trim option.");
  }
  const source = trim && typeof value === "string" ? value.trim() : value;
  if (targetType === "string") return { value: typeof value === "string" ? value : pyDumps(value, valueIsFloat), isFloat: false };
  if (targetType === "integer" || targetType === "number") {
    let number;
    let isFloat = false;
    if (typeof source === "string") {
      const pattern = targetType === "integer" ? /^-?(?:0|[1-9][0-9]*)$/ : /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
      if (source.length > (targetType === "integer" ? 20 : 128) || !pattern.test(source)) {
        throw valueError("Expected a decimal number; whitespace requires trim=true.");
      }
      if (targetType === "integer") {
        const big = BigInt(source);
        if (big < -(2n ** 63n) || big > 2n ** 63n - 1n) {
          throw valueError("Integer Cast requires an exact signed 64-bit integer; no truncation.");
        }
        if (big < BigInt(-SAFE) || big > BigInt(SAFE)) {
          throw valueError("JavaScript/TypeScript component implementations require integers within ±9007199254740991.");
        }
        return { value: Number(big), isFloat: false };
      }
      number = Number(source);
      isFloat = true;
      if (number === 0 && /[1-9]/.test(source.split(/[eE]/)[0])) throw valueError("Float underflow to zero is not permitted.");
    } else if (typeof source === "number") {
      number = source;
      isFloat = valueIsFloat;
    } else {
      throw valueError("Numeric Cast requires a number or decimal string, not a boolean.");
    }
    if (!Number.isFinite(number)) throw valueError("Cast requires a finite number.");
    if (targetType === "integer") {
      if (number !== Math.trunc(number) || number < -(2 ** 63) || number > 2 ** 63 - 1) {
        throw valueError("Integer Cast requires an exact signed 64-bit integer; no truncation.");
      }
      return { value: number, isFloat: false };
    }
    return { value: number, isFloat };
  }
  if (targetType === "boolean") {
    if (typeof source === "boolean") return { value: source, isFloat: false };
    if (source === "true" || source === "false") return { value: source === "true", isFloat: false };
    throw valueError("Boolean Cast requires true/false or their exact lowercase strings.");
  }
  let parsed = source;
  if (typeof source === "string") {
    if ([...source].length > 65536) throw valueError("JSON Cast input exceeds 64 KiB.");
    try { parsed = JSON.parse(source); } catch (error) { throw valueError(error.message); }
  }
  const matches = targetType === "object" ? parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    : targetType === "array" ? Array.isArray(parsed) : parsed === null;
  if (!matches) throw valueError("Cast JSON must match the selected target type: " + targetType);
  return { value: parsed, isFloat: false };
}

const MATH_ARITY = {
  log: [1, 2], log10: [1, 1], log2: [1, 1], log1p: [1, 1], sqrt: [1, 1], exp: [1, 1], expm1: [1, 1],
  sin: [1, 1], cos: [1, 1], tan: [1, 1], asin: [1, 1], acos: [1, 1], atan: [1, 1], atan2: [2, 2],
  sinh: [1, 1], cosh: [1, 1], tanh: [1, 1], degrees: [1, 1], radians: [1, 1], ceil: [1, 1], floor: [1, 1],
  trunc: [1, 1], fabs: [1, 1], hypot: [0, 32], fmod: [2, 2], copysign: [2, 2], abs: [1, 1], min: [2, 32],
  max: [2, 32], round: [1, 2],
};

function roundHalfEven(value) {
  const rounded = Math.round(value);
  return Math.abs(value % 1) === 0.5 ? 2 * Math.round(value / 2) : rounded;
}

function mathFunction(name, args) {
  const [low, high] = MATH_ARITY[name];
  if (args.length < low || args.length > high) throw valueError("Invalid math expression: " + name + "() takes " + low + " to " + high + " arguments");
  const x = args[0] ? args[0].v : 0;
  const domain = condition => { if (condition) throw valueError("math domain error"); };
  const float = value => num(value, true);
  switch (name) {
    case "log":
      domain(x <= 0);
      if (args.length === 2) {
        domain(args[1].v <= 0);
        if (args[1].v === 1) throw valueError("Invalid math expression: float division by zero");
        return float(Math.log(x) / Math.log(args[1].v));
      }
      return float(Math.log(x));
    case "log10": domain(x <= 0); return float(Math.log10(x));
    case "log2": domain(x <= 0); return float(Math.log2(x));
    case "log1p": domain(x <= -1); return float(Math.log1p(x));
    case "sqrt": domain(x < 0); return float(Math.sqrt(x));
    case "asin": domain(x < -1 || x > 1); return float(Math.asin(x));
    case "acos": domain(x < -1 || x > 1); return float(Math.acos(x));
    case "exp": case "expm1": case "sin": case "cos": case "tan": case "atan": case "sinh": case "cosh": case "tanh": {
      const result = Math[name](x);
      if (!Number.isFinite(result)) throw valueError("Invalid math expression: math range error");
      return float(result);
    }
    case "atan2": return float(Math.atan2(x, args[1].v));
    case "degrees": return float(x * 180 / Math.PI);
    case "radians": return float(x * Math.PI / 180);
    case "ceil": return num(Math.ceil(x), false);
    case "floor": return num(Math.floor(x), false);
    case "trunc": return num(Math.trunc(x), false);
    case "fabs": return float(Math.abs(x));
    case "hypot": return float(Math.hypot(...args.map(item => item.v)));
    case "fmod": domain(args[1].v === 0); return float(x % args[1].v);
    case "copysign": {
      const negative = args[1].v < 0 || Object.is(args[1].v, -0);
      return float(negative ? -Math.abs(x) : Math.abs(x));
    }
    case "abs": return num(Math.abs(x), args[0].f);
    case "min": case "max": {
      let best = args[0];
      for (const item of args.slice(1)) if (name === "min" ? item.v < best.v : item.v > best.v) best = item;
      return best;
    }
    case "round": {
      if (args.length === 1) return num(roundHalfEven(x), false);
      if (args[1].f) throw valueError("Invalid math expression: 'float' object cannot be interpreted as an integer");
      const scale = 10 ** args[1].v;
      return num(roundHalfEven(x * scale) / scale, args[0].f);
    }
  }
  throw valueError("Unsupported math syntax or function.");
}

function tokenize(source) {
  const tokens = [];
  const pattern = /\s*(?:(\d+\.\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+)|(\d+)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|\/\/|[-+*/%(),]))/y;
  let index = 0;
  while (index < source.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match || match[0].trim() === "") {
      if (/^\s*$/.test(source.slice(index))) break;
      throw valueError("Invalid math expression: invalid syntax");
    }
    index = pattern.lastIndex;
    if (match[1] !== undefined) tokens.push({ kind: "number", value: Number(match[1]), float: true });
    else if (match[2] !== undefined) {
      if (match[2].length > 1 && match[2].startsWith("0") && /[1-9]/.test(match[2])) throw valueError("Invalid math expression: leading zeros in decimal integer literals are not permitted");
      tokens.push({ kind: "number", value: Number(match[2]), float: false });
    } else if (match[3] !== undefined) tokens.push({ kind: "name", value: match[3] });
    else tokens.push({ kind: "op", value: match[4] });
  }
  return tokens;
}

function parse(source) {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const take = value => {
    const token = tokens[position];
    if (!token || (value !== undefined && token.value !== value)) throw valueError("Invalid math expression: invalid syntax");
    position += 1;
    return token;
  };
  const isOp = (...values) => peek() && peek().kind === "op" && values.includes(peek().value);
  function expression() {
    let node = term();
    while (isOp("+", "-")) node = { type: "bin", op: take().value, left: node, right: term() };
    return node;
  }
  function term() {
    let node = factor();
    while (isOp("*", "/", "//", "%")) node = { type: "bin", op: take().value, left: node, right: factor() };
    return node;
  }
  function factor() {
    if (isOp("+", "-")) return { type: "unary", op: take().value, operand: factor() };
    return power();
  }
  function power() {
    const base = atom();
    if (isOp("**")) { take(); return { type: "bin", op: "**", left: base, right: factor() }; }
    return base;
  }
  function atom() {
    const token = peek();
    if (!token) throw valueError("Invalid math expression: unexpected EOF while parsing");
    if (token.kind === "number") { take(); return { type: "const", value: token.value, float: token.float }; }
    if (token.kind === "name") {
      take();
      if (isOp("(")) {
        take();
        const args = [];
        if (!isOp(")")) {
          args.push(expression());
          while (isOp(",")) { take(); if (isOp(")")) break; args.push(expression()); }
        }
        take(")");
        return { type: "call", name: token.value, args };
      }
      return { type: "name", name: token.value };
    }
    if (isOp("(")) { take(); const node = expression(); take(")"); return node; }
    throw valueError("Invalid math expression: invalid syntax");
  }
  const tree = expression();
  if (position !== tokens.length) throw valueError("Invalid math expression: invalid syntax");
  return tree;
}

function astSize(node) {
  if (node.type === "const") return 1;
  if (node.type === "name") return 2;
  if (node.type === "unary") return 2 + astSize(node.operand);
  if (node.type === "bin") return 2 + astSize(node.left) + astSize(node.right);
  return 3 + node.args.reduce((total, item) => total + astSize(item), 0);
}

function pyMod(left, right, isFloat) {
  if (right.v === 0) throw valueError("Invalid math expression: " + (isFloat ? "float modulo" : "integer modulo by zero"));
  let result = left.v % right.v;
  if (result !== 0 && (result < 0) !== (right.v < 0)) result += right.v;
  if (result === 0 && isFloat) result = right.v < 0 ? -0 : 0;
  return result;
}

function binary(op, left, right) {
  const isFloat = left.f || right.f;
  if (op === "**" && Math.abs(right.v) > 100) throw valueError("Math exponent magnitude must not exceed 100.");
  switch (op) {
    case "+": return num(left.v + right.v, isFloat);
    case "-": return num(left.v - right.v, isFloat);
    case "*": return num(left.v * right.v, isFloat);
    case "/":
      if (right.v === 0) throw valueError("Invalid math expression: division by zero");
      return num(left.v / right.v, true);
    case "//":
      if (right.v === 0) throw valueError("Invalid math expression: " + (isFloat ? "float floor division by zero" : "integer division or modulo by zero"));
      return num(Math.floor(left.v / right.v), isFloat);
    case "%": return num(pyMod(left, right, isFloat), isFloat);
    case "**":
      if (left.v === 0 && right.v < 0) throw valueError("Invalid math expression: 0.0 cannot be raised to a negative power");
      return num(left.v ** right.v, isFloat || right.v < 0);
  }
  throw valueError("Unsupported math syntax or function.");
}

function mathExpression(expression, inputs, floatInputs) {
  if (typeof expression !== "string" || !expression.trim() || expression.length > 1024) {
    throw valueError("Math expression requires 1 to 1,024 characters.");
  }
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) throw valueError("Math inputs must be numbered numeric values.");
  const number = value => {
    if (typeof value.v !== "number" || !Number.isFinite(value.v) || Math.abs(value.v) > 1e100) {
      throw valueError("Math values must be finite numbers with magnitude at most 1e100.");
    }
    return value;
  };
  let source = expression.replace(/\{([0-9]+)\}/g, (match, digits) => {
    const index = Number(digits);
    if (index >= 32 || !Object.prototype.hasOwnProperty.call(inputs, "input_" + index)) throw valueError("Missing math input: " + match);
    return "_v" + index;
  });
  source = source.replace(/\bx\b/g, "*").split("^").join("**");
  const names = Object.keys(MATH_ARITY).join("|");
  source = source.replace(new RegExp("\\b(" + names + ")\\s+(_v[0-9]+|[0-9]+(?:\\.[0-9]+)?)\\b", "g"), "$1($2)");
  const tree = parse(source.trim());
  if (1 + astSize(tree) > 128) throw valueError("Math expression is too complex.");
  const constants = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
  function visit(node, depth) {
    if (depth > 32) throw valueError("Math nesting exceeds 32 levels.");
    if (node.type === "const") return number(num(node.value, node.float));
    if (node.type === "name") {
      if (/^_v[0-9]+$/.test(node.name)) {
        const field = "input_" + node.name.slice(2);
        if (!Object.prototype.hasOwnProperty.call(inputs, field)) throw valueError("Invalid math expression: '" + field + "'");
        return number(num(inputs[field], floatInputs.includes(field)));
      }
      if (node.name in constants) return num(constants[node.name], true);
    }
    if (node.type === "unary") {
      const value = visit(node.operand, depth + 1);
      return number(num(node.op === "-" ? -value.v : value.v, value.f));
    }
    if (node.type === "bin") {
      const left = visit(node.left, depth + 1);
      const right = visit(node.right, depth + 1);
      return number(binary(node.op, left, right));
    }
    if (node.type === "call" && Object.prototype.hasOwnProperty.call(MATH_ARITY, node.name)) {
      if (node.args.length < 1 || node.args.length > 32) throw valueError("Math functions require 1 to 32 positional arguments.");
      return number(mathFunction(node.name, node.args.map(item => visit(item, depth + 1))));
    }
    throw valueError("Unsupported math syntax or function.");
  }
  return visit(tree, 0);
}

function looseRealpath(target) {
  const parsed = path.parse(target);
  let current = parsed.root;
  let existing = true;
  for (const part of target.slice(parsed.root.length).split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") { current = path.dirname(current); continue; }
    const next = path.join(current, part);
    if (existing) {
      try { current = fs.realpathSync.native(next); continue; } catch { existing = false; }
    }
    current = next;
  }
  return current;
}

function within(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function filePath(values, context) {
  let reference = values.path;
  if (context.resolved_path) reference = context.resolved_path;
  else if (reference === "~" || reference.startsWith("~/") || reference.startsWith("~" + path.sep)) reference = os.homedir() + reference.slice(1);
  else if (reference.startsWith("~")) throw new ComponentError("PermissionError", "The JavaScript/TypeScript File Path implementation expands only the current user's ~.");
  const workspace = context.workspace;
  const resolved = looseRealpath(path.isAbsolute(reference) ? reference : path.join(workspace, reference));
  if (!within(resolved, workspace) || (values.must_exist && !fs.existsSync(resolved))) {
    throw new ComponentError("PermissionError", "File path is outside the Action workspace or does not exist.");
  }
  return resolved;
}

function run(request) {
  const values = request.inputs;
  const context = request.context || {};
  const floatInputs = context.float_inputs || [];
  switch (request.component) {
    case "core.constant": return { output: { value: values.value }, float_fields: floatInputs.includes("value") ? ["value"] : [] };
    case "core.cast": {
      const result = castValue(values.value, values.target_type, values.trim === undefined ? false : values.trim, floatInputs.includes("value"));
      return { output: { value: result.value }, float_fields: result.isFloat ? ["value"] : [] };
    }
    case "core.lookup": {
      const dictionary = values.dictionary;
      const field = values.key;
      const present = Object.prototype.hasOwnProperty.call(dictionary, field);
      if (!present && !Object.prototype.hasOwnProperty.call(values, "default")) throw new ComponentError("KeyError", "Dictionary key is missing: " + field);
      return { output: { value: present ? dictionary[field] : values.default }, float_fields: !present && floatInputs.includes("default") ? ["value"] : [] };
    }
    case "core.math-expression": {
      const result = mathExpression(values.expression, values, floatInputs);
      return { output: { value: result.v }, float_fields: result.f ? ["value"] : [] };
    }
    case "core.file-path": return { output: { path: filePath(values, context) }, float_fields: [] };
  }
  throw valueError("Component has no JavaScript implementation: " + request.component);
}

function main() {
  const chunks = [];
  process.stdin.on("data", chunk => chunks.push(chunk));
  process.stdin.on("end", () => {
    let response;
    try {
      response = { ok: true, ...run(JSON.parse(Buffer.concat(chunks).toString("utf8"))) };
    } catch (error) {
      response = { ok: false, error: { type: error instanceof ComponentError ? error.type : "ValueError", message: String(error && error.message || error) } };
    }
    process.stdout.write(JSON.stringify(response));
  });
}

module.exports = { run, castValue, mathExpression, filePath };
if (require.main === module) main();
