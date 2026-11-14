import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  projectRecipeCapabilities,
  registerRecipeCapabilitiesTool,
} from "../dist/legacy-recipe-capabilities-mcp.js";
import { startMcp } from "../dist/mcp.js";
import { readWorkflowCompiler } from "../dist/workflow-compiler.js";

const readNativeCapabilities = () => readWorkflowCompiler(".", {
  operation: "workflow.compiler.capabilities",
  args: {},
});

test("recipe capability tool registers as read-only and returns only a bounded native projection", async () => {
  let registration;
  const server = {
    registerTool(name, config, handler) {
      registration = { name, config, handler };
    },
  };
  registerRecipeCapabilitiesTool(server, readNativeCapabilities);

  assert.equal(registration.name, "recipe_capabilities");
  assert.deepEqual(registration.config.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(registration.config.inputSchema.parse({}), {});
  const result = await registration.handler({});
  const projection = result.structuredContent;

  assert.equal(result.isError, undefined);
  assert.equal(projection.schema, "pkm.recipe.capabilities-projection/v1");
  assert.equal(projection.capability, "pkm-recipes");
  assert.equal(projection.projection.originalRecipeRuntime, "not-implemented-by-native-workflow-surfaces");
  assert.deepEqual(projection.workflow, readNativeCapabilities());
  assert.deepEqual(projection.nativeOperations.recipes.map(item => item.operation), [
    "project.recipe.list", "project.recipe.get", "project.recipe.bundle.get",
  ]);
  assert.deepEqual(projection.nativeOperations.workflows.map(item => item.operation), [
    "workflow.compiler.capabilities", "workflow.definition.validate", "workflow.definition.compile",
  ]);
  assert.equal(projection.workflow.execution, "unavailable");
  assert(projection.workflow.kinds.every(kind => kind.runtimeAvailable === false));
  assert.deepEqual(projection.legacyRecipeToolsNotProvided, [
    "recipe_search", "recipe_create_from_skill", "recipe_run_start", "recipe_run_start_adhoc",
    "recipe_run_get", "recipe_run_next", "recipe_run_progress", "recipe_run_report",
    "recipe_run_submit_input", "recipe_usage_summary",
  ]);
  assert.equal(result.content[0].text, JSON.stringify(projection));
});

test("projection rejects capability data outside the native compiler contract", () => {
  assert.throws(() => projectRecipeCapabilities({
    schema: "pkm.workflow.compiler.capabilities/v1",
    execution: "available",
  }));
});

test("shared MCP server exposes recipe_capabilities from the native compiler read", async t => {
  const native = readNativeCapabilities();
  const core = {
    async dispatch(method, input) {
      if (method === "capabilities_describe") {
        assert.deepEqual(input, { operation: "recipe.compat.search" });
        return { error: { code: "NOT_FOUND", message: "No explicit native Recipe composition.", effect: "not_committed" } };
      }
      assert.equal(method, "capability_read");
      assert.deepEqual(input, {
        operation: "workflow.compiler.capabilities", version: 1, arguments: {},
      });
      return { result: native };
    },
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startMcp(core, { id: "reader", canWrite: false }, serverTransport);
  const client = new Client({ name: "recipe-capabilities-integration", version: "1.0.0" });
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(clientTransport);

  const tools = await client.listTools();
  assert(tools.tools.some(tool => tool.name === "recipe_capabilities"
    && tool.annotations.readOnlyHint === true && tool.annotations.openWorldHint === false));
  const result = await client.callTool({ name: "recipe_capabilities", arguments: {} });
  assert.equal(result.structuredContent.schema, "pkm.recipe.capabilities-projection/v1");
  assert.equal(result.structuredContent.workflow.execution, "unavailable");
});
