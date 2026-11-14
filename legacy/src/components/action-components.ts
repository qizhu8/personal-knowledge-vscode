// TypeScript implementation of PKM stateless core components.
// Compiled with the extension build; runs under Node via the same JSON stdin/stdout
// protocol as resources/action_components.js and the Python host implementation.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ErrorType = "ValueError" | "PermissionError" | "KeyError";
interface Numeric { v: number; f: boolean }
interface Request { component: string; inputs: { [key: string]: Json }; context?: Context }
interface Context { workspace?: string; resolved_path?: string | null; float_inputs?: string[] }
interface Result { output: { [key: string]: Json }; float_fields: string[] }
type Node =
  | { type: "const"; value: number; float: boolean }
  | { type: "name"; name: string }
  | { type: "unary"; op: string; operand: Node }
  | { type: "bin"; op: string; left: Node; right: Node }
  | { type: "call"; name: string; args: Node[] };

const SAFE = Number.MAX_SAFE_INTEGER;
const VALUE_TYPES = ["string", "integer", "number", "boolean", "object", "array", "null"];
const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

export class ComponentError extends Error {
  constructor(public readonly type: ErrorType, message: string) { super(message); }
}
const valueError = (message: string): ComponentError => new ComponentError("ValueError", message);
const numeric = (v: number, f: boolean): Numeric => ({ v, f });

function pythonFloat(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  const [mantissa, exponentText] = value.toExponential().split("e");
  const exponent = Number(exponentText);
  const digits = mantissa.replace("-", "").replace(".", "");
  const sign = value < 0 ? "-" : "";
  if (exponent < -4 || exponent >= 16) {
    const body = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${body}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  const whole = digits.padEnd(exponent + 1, "0");
  return `${sign}${whole.slice(0, exponent + 1)}.${digits.slice(exponent + 1) || "0"}`;
}

function pythonJson(value: Json, isFloat: boolean): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw valueError("Out of range float values are not JSON compliant");
    return isFloat ? pythonFloat(value) : String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => pythonJson(item, false)).join(", ")}]`;
  return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item, false)}`).join(", ")}}`;
}

export function castValue(value: Json, targetType: Json, trim: Json, valueIsFloat: boolean): { value: Json; isFloat: boolean } {
  if (typeof targetType !== "string" || !VALUE_TYPES.includes(targetType) || typeof trim !== "boolean") {
    throw valueError("Choose a supported Cast target type and boolean trim option.");
  }
  const source = trim && typeof value === "string" ? value.trim() : value;
  if (targetType === "string") return { value: typeof value === "string" ? value : pythonJson(value, valueIsFloat), isFloat: false };
  if (targetType === "integer" || targetType === "number") {
    let number: number;
    let isFloat = false;
    if (typeof source === "string") {
      const pattern = targetType === "integer" ? /^-?(?:0|[1-9][0-9]*)$/ : /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
      if (source.length > (targetType === "integer" ? 20 : 128) || !pattern.test(source)) {
        throw valueError("Expected a decimal number; whitespace requires trim=true.");
      }
      if (targetType === "integer") {
        const big = BigInt(source);
        if (big < -(BigInt(2) ** BigInt(63)) || big > BigInt(2) ** BigInt(63) - BigInt(1)) {
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
  let parsed: Json = source;
  if (typeof source === "string") {
    if ([...source].length > 65536) throw valueError("JSON Cast input exceeds 64 KiB.");
    try { parsed = JSON.parse(source) as Json; } catch (error) { throw valueError((error as Error).message); }
  }
  const matches = targetType === "object" ? parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    : targetType === "array" ? Array.isArray(parsed) : parsed === null;
  if (!matches) throw valueError(`Cast JSON must match the selected target type: ${targetType}`);
  return { value: parsed, isFloat: false };
}

const MATH_ARITY: { [name: string]: [number, number] } = {
  log: [1, 2], log10: [1, 1], log2: [1, 1], log1p: [1, 1], sqrt: [1, 1], exp: [1, 1], expm1: [1, 1],
  sin: [1, 1], cos: [1, 1], tan: [1, 1], asin: [1, 1], acos: [1, 1], atan: [1, 1], atan2: [2, 2],
  sinh: [1, 1], cosh: [1, 1], tanh: [1, 1], degrees: [1, 1], radians: [1, 1], ceil: [1, 1], floor: [1, 1],
  trunc: [1, 1], fabs: [1, 1], hypot: [0, 32], fmod: [2, 2], copysign: [2, 2], abs: [1, 1], min: [2, 32],
  max: [2, 32], round: [1, 2],
};
const UNARY_MATH: { [name: string]: (value: number) => number } = {
  exp: Math.exp, expm1: Math.expm1, sin: Math.sin, cos: Math.cos, tan: Math.tan, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
};

function roundHalfEven(value: number): number {
  return Math.abs(value % 1) === 0.5 ? 2 * Math.round(value / 2) : Math.round(value);
}

function mathFunction(name: string, args: Numeric[]): Numeric {
  const [low, high] = MATH_ARITY[name];
  if (args.length < low || args.length > high) throw valueError(`Invalid math expression: ${name}() takes ${low} to ${high} arguments`);
  const x = args.length ? args[0].v : 0;
  const domain = (condition: boolean): void => { if (condition) throw valueError("math domain error"); };
  const float = (value: number): Numeric => numeric(value, true);
  if (name in UNARY_MATH) {
    const result = UNARY_MATH[name](x);
    if (!Number.isFinite(result)) throw valueError("Invalid math expression: math range error");
    return float(result);
  }
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
    case "atan2": return float(Math.atan2(x, args[1].v));
    case "degrees": return float(x * 180 / Math.PI);
    case "radians": return float(x * Math.PI / 180);
    case "ceil": return numeric(Math.ceil(x), false);
    case "floor": return numeric(Math.floor(x), false);
    case "trunc": return numeric(Math.trunc(x), false);
    case "fabs": return float(Math.abs(x));
    case "hypot": return float(Math.hypot(...args.map(item => item.v)));
    case "fmod": domain(args[1].v === 0); return float(x % args[1].v);
    case "copysign": return float(args[1].v < 0 || Object.is(args[1].v, -0) ? -Math.abs(x) : Math.abs(x));
    case "abs": return numeric(Math.abs(x), args[0].f);
    case "min":
    case "max":
      return args.slice(1).reduce((best, item) => (name === "min" ? item.v < best.v : item.v > best.v) ? item : best, args[0]);
    case "round": {
      if (args.length === 1) return numeric(roundHalfEven(x), false);
      if (args[1].f) throw valueError("Invalid math expression: 'float' object cannot be interpreted as an integer");
      const scale = 10 ** args[1].v;
      return numeric(roundHalfEven(x * scale) / scale, args[0].f);
    }
  }
  throw valueError("Unsupported math syntax or function.");
}

type Token = { kind: "number"; value: number; float: boolean } | { kind: "name" | "op"; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
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
      if (match[2].length > 1 && match[2].startsWith("0") && /[1-9]/.test(match[2])) {
        throw valueError("Invalid math expression: leading zeros in decimal integer literals are not permitted");
      }
      tokens.push({ kind: "number", value: Number(match[2]), float: false });
    } else if (match[3] !== undefined) tokens.push({ kind: "name", value: match[3] });
    else tokens.push({ kind: "op", value: match[4] });
  }
  return tokens;
}

function parse(source: string): Node {
  const tokens = tokenize(source);
  let position = 0;
  const isOp = (...values: string[]): boolean => {
    const token = tokens[position];
    return !!token && token.kind === "op" && values.includes(token.value);
  };
  const take = (value?: string): Token => {
    const token = tokens[position];
    if (!token || (value !== undefined && token.value !== value)) throw valueError("Invalid math expression: invalid syntax");
    position += 1;
    return token;
  };
  const expression = (): Node => {
    let node = term();
    while (isOp("+", "-")) node = { type: "bin", op: String(take().value), left: node, right: term() };
    return node;
  };
  const term = (): Node => {
    let node = factor();
    while (isOp("*", "/", "//", "%")) node = { type: "bin", op: String(take().value), left: node, right: factor() };
    return node;
  };
  const factor = (): Node => isOp("+", "-") ? { type: "unary", op: String(take().value), operand: factor() } : power();
  const power = (): Node => {
    const base = atom();
    if (!isOp("**")) return base;
    take();
    return { type: "bin", op: "**", left: base, right: factor() };
  };
  const atom = (): Node => {
    const token = tokens[position];
    if (!token) throw valueError("Invalid math expression: unexpected EOF while parsing");
    if (token.kind === "number") { take(); return { type: "const", value: token.value, float: token.float }; }
    if (token.kind === "name") {
      take();
      if (!isOp("(")) return { type: "name", name: token.value };
      take();
      const args: Node[] = [];
      if (!isOp(")")) {
        args.push(expression());
        while (isOp(",")) { take(); if (isOp(")")) break; args.push(expression()); }
      }
      take(")");
      return { type: "call", name: token.value, args };
    }
    if (isOp("(")) { take(); const node = expression(); take(")"); return node; }
    throw valueError("Invalid math expression: invalid syntax");
  };
  const tree = expression();
  if (position !== tokens.length) throw valueError("Invalid math expression: invalid syntax");
  return tree;
}

function astSize(node: Node): number {
  switch (node.type) {
    case "const": return 1;
    case "name": return 2;
    case "unary": return 2 + astSize(node.operand);
    case "bin": return 2 + astSize(node.left) + astSize(node.right);
    case "call": return 3 + node.args.reduce((total, item) => total + astSize(item), 0);
  }
}

function binary(op: string, left: Numeric, right: Numeric): Numeric {
  const isFloat = left.f || right.f;
  if (op === "**" && Math.abs(right.v) > 100) throw valueError("Math exponent magnitude must not exceed 100.");
  switch (op) {
    case "+": return numeric(left.v + right.v, isFloat);
    case "-": return numeric(left.v - right.v, isFloat);
    case "*": return numeric(left.v * right.v, isFloat);
    case "/":
      if (right.v === 0) throw valueError("Invalid math expression: division by zero");
      return numeric(left.v / right.v, true);
    case "//":
      if (right.v === 0) throw valueError(`Invalid math expression: ${isFloat ? "float floor division by zero" : "integer division or modulo by zero"}`);
      return numeric(Math.floor(left.v / right.v), isFloat);
    case "%": {
      if (right.v === 0) throw valueError(`Invalid math expression: ${isFloat ? "float modulo" : "integer modulo by zero"}`);
      let result = left.v % right.v;
      if (result !== 0 && (result < 0) !== (right.v < 0)) result += right.v;
      if (result === 0 && isFloat) result = right.v < 0 ? -0 : 0;
      return numeric(result, isFloat);
    }
    case "**":
      if (left.v === 0 && right.v < 0) throw valueError("Invalid math expression: 0.0 cannot be raised to a negative power");
      return numeric(left.v ** right.v, isFloat || right.v < 0);
  }
  throw valueError("Unsupported math syntax or function.");
}

export function mathExpression(expression: Json, inputs: { [key: string]: Json }, floatInputs: string[]): Numeric {
  if (typeof expression !== "string" || !expression.trim() || expression.length > 1024) {
    throw valueError("Math expression requires 1 to 1,024 characters.");
  }
  const finite = (value: Numeric): Numeric => {
    if (typeof value.v !== "number" || !Number.isFinite(value.v) || Math.abs(value.v) > 1e100) {
      throw valueError("Math values must be finite numbers with magnitude at most 1e100.");
    }
    return value;
  };
  let source = expression.replace(/\{([0-9]+)\}/g, (match: string, digits: string) => {
    const index = Number(digits);
    if (index >= 32 || !has(inputs, `input_${index}`)) throw valueError(`Missing math input: ${match}`);
    return `_v${index}`;
  });
  source = source.replace(/\bx\b/g, "*").split("^").join("**");
  source = source.replace(new RegExp(`\\b(${Object.keys(MATH_ARITY).join("|")})\\s+(_v[0-9]+|[0-9]+(?:\\.[0-9]+)?)\\b`, "g"), "$1($2)");
  const tree = parse(source.trim());
  if (1 + astSize(tree) > 128) throw valueError("Math expression is too complex.");
  const constants: { [name: string]: number } = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
  const visit = (node: Node, depth: number): Numeric => {
    if (depth > 32) throw valueError("Math nesting exceeds 32 levels.");
    switch (node.type) {
      case "const": return finite(numeric(node.value, node.float));
      case "name": {
        if (/^_v[0-9]+$/.test(node.name)) {
          const field = `input_${node.name.slice(2)}`;
          if (!has(inputs, field)) throw valueError(`Invalid math expression: '${field}'`);
          return finite(numeric(inputs[field] as number, floatInputs.includes(field)));
        }
        if (has(constants, node.name)) return numeric(constants[node.name], true);
        break;
      }
      case "unary": {
        const value = visit(node.operand, depth + 1);
        return finite(numeric(node.op === "-" ? -value.v : value.v, value.f));
      }
      case "bin": {
        const left = visit(node.left, depth + 1);
        const right = visit(node.right, depth + 1);
        return finite(binary(node.op, left, right));
      }
      case "call":
        if (!has(MATH_ARITY, node.name)) break;
        if (node.args.length < 1 || node.args.length > 32) throw valueError("Math functions require 1 to 32 positional arguments.");
        return finite(mathFunction(node.name, node.args.map(item => visit(item, depth + 1))));
    }
    throw valueError("Unsupported math syntax or function.");
  };
  return visit(tree, 0);
}

function looseRealpath(target: string): string {
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

function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function filePath(values: { [key: string]: Json }, context: Context): string {
  let reference = String(values.path);
  if (context.resolved_path) reference = context.resolved_path;
  else if (reference === "~" || reference.startsWith("~/") || reference.startsWith(`~${path.sep}`)) reference = os.homedir() + reference.slice(1);
  else if (reference.startsWith("~")) {
    throw new ComponentError("PermissionError", "The JavaScript/TypeScript File Path implementation expands only the current user's ~.");
  }
  const workspace = String(context.workspace);
  const resolved = looseRealpath(path.isAbsolute(reference) ? reference : path.join(workspace, reference));
  if (!within(resolved, workspace) || (values.must_exist === true && !fs.existsSync(resolved))) {
    throw new ComponentError("PermissionError", "File path is outside the Action workspace or does not exist.");
  }
  return resolved;
}

export function run(request: Request): Result {
  const values = request.inputs;
  const context = request.context || {};
  const floatInputs = context.float_inputs || [];
  switch (request.component) {
    case "core.constant":
      return { output: { value: values.value }, float_fields: floatInputs.includes("value") ? ["value"] : [] };
    case "core.cast": {
      const result = castValue(values.value, values.target_type, values.trim === undefined ? false : values.trim, floatInputs.includes("value"));
      return { output: { value: result.value }, float_fields: result.isFloat ? ["value"] : [] };
    }
    case "core.lookup": {
      const dictionary = values.dictionary as { [key: string]: Json };
      const field = String(values.key);
      const present = has(dictionary, field);
      if (!present && !has(values, "default")) throw new ComponentError("KeyError", `Dictionary key is missing: ${field}`);
      return { output: { value: present ? dictionary[field] : values.default },
        float_fields: !present && floatInputs.includes("default") ? ["value"] : [] };
    }
    case "core.math-expression": {
      const result = mathExpression(values.expression, values, floatInputs);
      return { output: { value: result.v }, float_fields: result.f ? ["value"] : [] };
    }
    case "core.file-path":
      return { output: { path: filePath(values, context) }, float_fields: [] };
  }
  throw valueError(`Component has no TypeScript implementation: ${request.component}`);
}

function main(): void {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on("end", () => {
    let response: object;
    try {
      response = { ok: true, ...run(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request) };
    } catch (error) {
      response = { ok: false, error: { type: error instanceof ComponentError ? error.type : "ValueError",
        message: String((error as Error)?.message ?? error) } };
    }
    process.stdout.write(JSON.stringify(response));
  });
}

if (require.main === module) main();
