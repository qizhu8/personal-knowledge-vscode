#!/usr/bin/env node
const assert = require("assert");
const { recipeBrowserEditorDocument } = require("../dist/recipe-browser.js");

const recipe = {
  recipeId: "recipe_browser_test",
  scope: "global",
  category: "Examples/Web",
  name: "Browser </script> Recipe",
  description: "Editable standalone Recipe",
  metadata: {
    applicableFunctions: ["browser editing"],
    solution: "Edit and persist from the browser.",
    requiredInputs: [{ name: "request", description: "User request", required: true }],
    expectedOutputs: [{ name: "result", description: "Saved Recipe" }]
  },
  definition: {
    schema: "pkm.workflow.definition/v1",
    spec: {
      inputs: {},
      nodes: [{ nodeId: "edit", kind: "pkm.step.noop/v1", config: {}, dependsOn: [], ports: { inputs: [], outputs: [] }, generalInstruction: "Edit safely" }],
      outputs: {},
      completion: { requiredNodes: ["edit"] }
    }
  },
  nodeBindings: [],
  executableDigest: "abc123",
  revision: 3
};

const html = recipeBrowserEditorDocument(recipe, [{ id: "analysis-env", name: "Analysis", python: "/opt/analysis/bin/python" }]);
assert.match(html, /Automation Recipe/);
assert.match(html, /id="name"/);
assert.match(html, /data-collection="requiredInputs"/);
assert.match(html, /data-mode="graph"/);
assert.match(html, /data-mode="json"/);
assert.match(html, /id="validate"/);
assert.match(html, /id="save"/);
assert.match(html, /class="graph-links"/, "browser Graph renders directional SVG dependencies");
assert.match(html, /background-image:radial-gradient/, "browser Graph uses the Recipe Library canvas treatment");
assert.match(html, /id="add-node">Add Module/, "browser Graph can add components");
assert.match(html, /data-edit=/, "browser Graph components expose direct editing");
assert.match(html, /tab\('intent'\).*tab\('parameters'\).*tab\('references'\)/, "browser component editor exposes Intent, Parameters, and References");
assert.match(html, /data-dependency=/, "browser component editor manages dependencies");
assert.match(html, /data-ref-kind=/, "browser component editor manages Skill and Note bindings");
assert.match(html, /fetch\(path/);
assert.match(html, /method:'PUT'/);
assert.match(html, /beforeunload/);
assert.match(html, /pkm\.step\.script\/v1/, "standalone editor exposes the Script adapter kind");
assert.match(html, /Bash · Linux \/ macOS/, "standalone editor explains Bash platform support");
assert.match(html, /PowerShell · Windows/, "standalone editor explains PowerShell platform support");
assert.match(html, /Python · PKM Environment/, "standalone editor binds Python to PKM Environments");
assert.match(html, /analysis-env/);
assert.match(html, /\/opt\/analysis\/bin\/python/);
assert.doesNotMatch(html, /Browser <\/script> Recipe/, "embedded Recipe JSON must not terminate the script element");
assert.match(html, /Browser \\u003c\/script> Recipe/);

const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert(script, "standalone Recipe workbench must include its client script");
assert.doesNotThrow(() => new Function(script), "standalone Recipe client script must parse");

console.log("recipe browser editor test: metadata, Graph/JSON, validation, save, and safe embedding OK");
