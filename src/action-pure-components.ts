import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { ActionAuthorizationBinding, ActionNativeAdapter } from "./action-runtime.js";
import { exactRunnablePureBuiltin, originalDigest, runnablePureBuiltinSourceHash } from "./domain/action-compiler-validation.js";

const engineDigest = "ee0cf2ca9184342c9bfba0103550d1c52610a0a818832c4e869f0db49fa197d9";
const supported = new Set(["core.constant", "core.math-expression", "core.cast", "core.lookup"]);
const builtinCast: Readonly<Record<string, string>> = Object.freeze({
  "core.cast.string-to-float": "number",
});

function containsUnsafeInteger(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value) && !Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.some(containsUnsafeInteger);
  return value !== null && typeof value === "object" && Object.values(value).some(containsUnsafeInteger);
}
type Engine = { run(request: { component: string; inputs: Record<string, unknown>; context: { float_inputs: string[] } }):
  { output: Record<string, unknown> } };

export function supportedPureMathExpression(expression: string): boolean {
  if (!/\bround\b/.test(expression)) return true;
  return /^\s*round\s*\(\s*(?:\{\d+\}|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(?:,\s*[+-]?\d+)?\s*\)\s*$/.test(expression);
}

function engine(): Engine {
  const file = realpathSync(resolve(fileURLToPath(new URL(".", import.meta.url)), "../legacy/resources/action_components.js"));
  const before = statSync(file);
  if (!before.isFile() || createHash("sha256").update(readFileSync(file)).digest("hex") !== engineDigest)
    throw new Error("The original JavaScript component engine is unavailable or failed its source hash.");
  const loaded = createRequire(import.meta.url)(file) as Engine;
  const after = statSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || typeof loaded.run !== "function")
    throw new Error("The original component engine changed while loading.");
  return loaded;
}

export function pureComponentAvailable(): boolean {
  try { engine(); return true; } catch { return false; }
}

export function pureComponentAdapter(key: string, outputContractDigest: string): ActionNativeAdapter | undefined {
  const builtin = key.startsWith("action:") ? key.slice("action:".length) : undefined;
  const component = builtin && Object.hasOwn(builtinCast, builtin) ? "core.cast"
    : key.startsWith("component:") ? key.slice("component:".length) : "";
  if (!supported.has(component) || !pureComponentAvailable()) return undefined;
  const authorized = (binding: ActionAuthorizationBinding) =>
    builtin ? binding.implementation.kind === "builtin" && binding.actionId === builtin
      && exactRunnablePureBuiltin(binding.definition)
      : binding.implementation.kind === "pipeline" && binding.step?.component === component
        && binding.step.implementation === "javascript";
  return {
    id: `original-js-${builtin ?? component}`, version: 1, outputContractDigest,
    authorizationDigest: builtin ? originalDigest({ engine: engineDigest, source: runnablePureBuiltinSourceHash(builtin) }) : engineDigest,
    authorizeDefinition: authorized, authorizeData: authorized,
    async execute(invocation, context) {
      if (context.signal.aborted) return { status: "unknown" };
      if (component === "core.math-expression" && typeof invocation.inputs.expression === "string"
        && !supportedPureMathExpression(invocation.inputs.expression))
        return { status: "failed", reason: "ACTION_COMPONENT_UNSUPPORTED" };
      if ((component === "core.cast" || component === "core.lookup") && containsUnsafeInteger(invocation.inputs))
        return { status: "failed", reason: "ACTION_COMPONENT_UNSUPPORTED" };
      if (!builtin && component === "core.cast" && invocation.inputs.target_type === "string"
        && (typeof invocation.inputs.value === "number" && Number.isInteger(invocation.inputs.value)
          || invocation.inputs.value !== null && typeof invocation.inputs.value === "object"))
        return { status: "failed", reason: "ACTION_COMPONENT_UNSUPPORTED" };
      if (builtin && invocation.inputs.trim === true && typeof invocation.inputs.value === "string") {
        const value = invocation.inputs.value;
        const pythonTrim = value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, "");
        if (value.trim() !== pythonTrim) return { status: "failed", reason: "ACTION_COMPONENT_UNSUPPORTED" };
      }
      try {
        const values: unknown[] = [invocation.inputs];
        while (values.length) {
          const value = values.pop();
          if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value))
            throw new Error("Component integer is outside the JavaScript safe range.");
          if (Array.isArray(value)) for (const child of value) values.push(child);
          else if (value && typeof value === "object")
            for (const child of Object.values(value)) values.push(child);
        }
        const inputs = builtin ? {
          value: invocation.inputs.value, target_type: builtinCast[builtin],
          ...(Object.hasOwn(invocation.inputs, "trim") ? { trim: invocation.inputs.trim } : {}),
        } : invocation.inputs;
        if (inputs.target_type === "integer" && typeof inputs.value === "string") {
          const text = inputs.trim === true ? inputs.value.trim() : inputs.value;
          if (text.length <= 20 && /^-?(?:0|[1-9][0-9]*)$/.test(text)) {
            const integer = BigInt(text);
            if (integer >= -(2n ** 63n) && integer <= 2n ** 63n - 1n
              && (integer < BigInt(Number.MIN_SAFE_INTEGER) || integer > BigInt(Number.MAX_SAFE_INTEGER)))
              return { status: "failed", reason: "ACTION_COMPONENT_UNSUPPORTED" };
          }
        }
        const float_inputs = Object.entries(inputs)
          .filter(([, value]) => typeof value === "number" && !Number.isInteger(value)).map(([key]) => key);
        const result = engine().run({ component, inputs, context: { float_inputs } });
        if ((component === "core.cast" || component === "core.lookup") && containsUnsafeInteger(result.output))
          return { status: "failed", reason: "ACTION_COMPONENT_UNSUPPORTED" };
        if (builtin === "core.cast.string-to-float" && Object.is(result.output.value, -0))
          return { status: "failed", reason: "ACTION_COMPONENT_UNSUPPORTED" };
        return { status: "succeeded", outputs: result.output };
      } catch {
        return { status: "failed" };
      }
    },
  };
}
