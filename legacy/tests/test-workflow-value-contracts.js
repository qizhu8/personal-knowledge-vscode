#!/usr/bin/env node
const assert = require("assert");
const {
  WORKFLOW_VALUE_TYPES, WorkflowValueError, normalizeDecimal, normalizeInt64,
  normalizePortDescriptor, normalizeTypedValue, requiredInputDigest
} = require("../dist/workflows/value-contracts.js");

const error = (action, code, pointer) => assert.throws(action, value => value instanceof WorkflowValueError && value.code === code && (pointer === undefined || value.pointer === pointer));
const scalar = (type, options = {}) => ({ type, required: true, nullable: false, schema: {}, ...options });

assert.deepStrictEqual(WORKFLOW_VALUE_TYPES, ["object", "array", "string", "boolean", "int64", "decimal", "null", "artifact", "secret-handle"]);
assert.strictEqual(normalizeInt64("0"), "0");
assert.strictEqual(normalizeInt64("-9223372036854775808"), "-9223372036854775808");
assert.strictEqual(normalizeInt64("9223372036854775807"), "9223372036854775807");
for (const value of [0, "-0", "+1", "01", "1_0", "1e2"]) error(() => normalizeInt64(value), "int64-lexical");
for (const value of ["-9223372036854775809", "9223372036854775808"]) error(() => normalizeInt64(value), "int64-range");

assert.strictEqual(normalizeDecimal("12.3400"), "12.34");
assert.strictEqual(normalizeDecimal("-0.000"), "0");
assert.strictEqual(normalizeDecimal("10"), "10");
assert.strictEqual(normalizeDecimal("-1.2"), "-1.2");
for (const value of [1.2, "+1", "01", ".1", "1.", "1e2"]) error(() => normalizeDecimal(value), "decimal-lexical");

error(() => normalizePortDescriptor(null), "type");
error(() => normalizePortDescriptor({ ...scalar("string"), extra: true }), "unknown-field", "/extra");
error(() => normalizePortDescriptor(scalar("wat")), "value-type", "/type");
error(() => normalizePortDescriptor({ ...scalar("string"), required: "yes" }), "type", "/required");
error(() => normalizePortDescriptor({ ...scalar("string"), nullable: 0 }), "type", "/nullable");
error(() => normalizePortDescriptor({ ...scalar("string"), schema: [] }), "type", "/schema");
error(() => normalizePortDescriptor({ ...scalar("string"), schema: { format: "email" } }), "scalar-schema");

const objectPort = normalizePortDescriptor({
  type: "object", required: true, nullable: false,
  schema: { properties: {
    title: { ...scalar("string"), default: "cafe\u0301" },
    count: scalar("int64"),
    ratio: { ...scalar("decimal"), required: false },
    enabled: scalar("boolean"),
    empty: scalar("null"),
    artifact: scalar("artifact"),
    secret: scalar("secret-handle")
  } }
});
assert.deepStrictEqual(normalizeTypedValue(objectPort, {
  count: "2", enabled: true, empty: null,
  artifact: { evidenceId: "ev_1", digest: "sha256:1" },
  secret: { secretId: "secret_1", versionId: "v1" }
}), {
  artifact: { evidenceId: "ev_1", digest: "sha256:1" }, count: "2", empty: null,
  enabled: true, secret: { secretId: "secret_1", versionId: "v1" }, title: "café"
});
error(() => normalizeTypedValue(objectPort, {
  enabled: true, empty: null, artifact: { evidenceId: "e", digest: "d" }, secret: { secretId: "s", versionId: "v" }
}), "required", "/count");
error(() => normalizeTypedValue(objectPort, { surprise: 1 }), "unknown-field", "/surprise");
error(() => normalizeTypedValue(objectPort, []), "type");

const arrayPort = normalizePortDescriptor({ type: "array", required: true, nullable: false, schema: { items: scalar("decimal"), minItems: 1, maxItems: 2 } });
assert.deepStrictEqual(normalizeTypedValue(arrayPort, ["1.00", "2.50"]), ["1", "2.5"]);
error(() => normalizeTypedValue(arrayPort, "1"), "type");
error(() => normalizeTypedValue(arrayPort, []), "array-min");
error(() => normalizeTypedValue(arrayPort, ["1", "2", "3"]), "array-max");
error(() => normalizePortDescriptor({ type: "array", required: true, nullable: false, schema: { items: scalar("string"), minItems: 2, maxItems: 1 } }), "array-bounds");
for (const [field, value] of [["minItems", -1], ["maxItems", 1.2]]) error(() => normalizePortDescriptor({ type: "array", required: true, nullable: false, schema: { items: scalar("string"), [field]: value } }), "array-bound");
assert.deepStrictEqual(normalizePortDescriptor({ type: "array", required: true, nullable: false, schema: { items: scalar("string"), minItems: 1 } }).schema.minItems, 1);
assert.deepStrictEqual(normalizePortDescriptor({ type: "array", required: true, nullable: false, schema: { items: scalar("string"), maxItems: 2 } }).schema.maxItems, 2);

assert.strictEqual(normalizeTypedValue({ ...scalar("string"), nullable: true }, null), null);
assert.strictEqual(normalizeTypedValue(scalar("boolean"), false), false);
assert.strictEqual(normalizeTypedValue(scalar("null"), null), null);
error(() => normalizeTypedValue(scalar("null"), "x"), "type");
error(() => normalizeTypedValue(scalar("string"), null), "null");
error(() => normalizeTypedValue(scalar("string"), 1), "type");
error(() => normalizeTypedValue(scalar("string"), "\ud800"), "unicode");
error(() => normalizeTypedValue(scalar("boolean"), "true"), "type");
error(() => normalizeTypedValue(scalar("artifact"), []), "type");
error(() => normalizeTypedValue(scalar("artifact"), { evidenceId: "e", digest: "d", extra: "x" }), "unknown-field");
error(() => normalizeTypedValue(scalar("artifact"), { evidenceId: "", digest: "d" }), "reference");
error(() => normalizeTypedValue(scalar("secret-handle"), { secretId: "s", versionId: 1 }), "type");
error(() => normalizePortDescriptor({ type: "object", required: true, nullable: false, schema: {} }), "type", "/schema/properties");
error(() => normalizePortDescriptor({ type: "object", required: true, nullable: false, schema: { properties: { "bad key": scalar("string") } } }), "identifier");
error(() => normalizePortDescriptor({ type: "object", required: true, nullable: false, schema: { properties: { "é": scalar("string"), "e\u0301": scalar("string") } } }), "identifier");
error(() => normalizePortDescriptor({ type: "array", required: true, nullable: false, schema: { items: null } }), "type", "/schema/items");

const digestInput = {
  portSchemaDigests: { a: "schema" }, values: { a: "2" }, artifactDigests: {},
  secretVersionIds: { token: "v1" }, configurationSnapshotIds: { project: "cfg1" }
};
assert.strictEqual(requiredInputDigest(digestInput), requiredInputDigest(JSON.parse(JSON.stringify(digestInput))));
assert.notStrictEqual(requiredInputDigest(digestInput), requiredInputDigest({ ...digestInput, secretVersionIds: { token: "v2" } }));
console.log("workflow value contracts test: scalar, port, value, and digest contracts OK");
