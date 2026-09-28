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
  methodology: {
    schema: "pkm.recipe.methodology/v1",
    family: "validation-and-testing",
    phase: "validate",
    abstract: false,
    mixins: [],
    capabilities: ["adaptive-test-selection"],
    artifacts: { inputs: ["task-contract"], outputs: ["evidence-bundle"] },
    gates: ["independent-acceptance-gate"],
    invariants: ["coverage-is-not-acceptance"],
    expansion: { mode: "adaptive", signals: ["risk"] },
    communication: { minimumAssurance: "structured-acknowledgement", escalateOn: ["risk"] },
    retrieval: {
      intents: ["validate a feature end to end"],
      terminology: ["test matrix"],
      operationalPoints: ["ui", "security", "simulation"]
    }
  },
  methodologyDigest: "methodology-digest",
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
assert.match(html, /id="methodology"/);
assert.match(html, /data-methodology-view="pyramid"/);
assert.match(html, /data-methodology-view="composition"/);
assert.match(html, /data-methodology-view="evidence"/);
assert.match(html, /data-methodology-view="retrieval"/);
assert.match(html, /coverage-is-not-acceptance/);
assert.match(html, /id="validate"/);
assert.match(html, /id="save"/);
assert.match(html, /id="cancel"/);
assert.match(html, /class="graph-links"/, "browser Graph renders directional SVG dependencies");
assert.match(html, /background-image:radial-gradient/, "browser Graph uses the Recipe Library canvas treatment");
assert.match(html, /id="add-node">Add Module/, "browser Graph can add components");
assert.match(html, /class="workbench"/, "browser Graph uses the full-window workbench layout");
assert.match(html, /id="reorganize">Re-organize/, "browser Graph can restore the shared dependency layout");
assert.match(html, /id="create-module-id"/, "browser Graph requests a stable Module ID");
assert.match(html, /id="create-module-type"/, "browser Graph uses the shared Module type chooser");
assert.match(html, /id="create-module-confirm"/, "browser Graph confirms Module creation before editing");
assert.match(html, /port-handle output/, "browser Graph exposes interactive output ports");
assert.match(html, /function connectModules/, "browser Graph creates connections interactively");
assert.match(html, /function cancelDraft/, "Cancel restores the saved Recipe");
assert.match(html, /repeat-badge/, "Repeat renders as a grouping rectangle with a corner badge");
assert.match(html, /edge-hit/, "connections expose usable hit targets");
assert.match(html, /edge-hit\{[^}]*stroke-width:20/, "browser Connections have a forgiving pointer hit target");
assert.match(html, /deleteSelectedEdge/, "selected connections can be deleted");
assert.match(html, /\['Delete','Backspace'\]/, "Delete and Backspace remove the selected connection");
assert.match(html, /RecipeGraph\.terms/, "standalone Browser uses centralized Recipe terminology");
assert.match(html, /RecipeGraph\.moduleTemplates/, "standalone Browser uses shared Module templates");
assert.match(html, /RecipeGraph\.organizedPositions/, "standalone Browser uses shared dependency layout");
assert.match(html, /RecipeGraph\.edgeRoute/, "standalone Browser uses shared Connection routing");
assert.match(html, /RecipeGraph\.unconnectedNodeIds/, "standalone Browser blocks incomplete new Modules");
assert.match(html, /RecipeGraph\.constrainBoundary/, "standalone Browser shares Input and Output constraints");
assert.match(html, /function bindBoundaryDrag/, "standalone Browser supports boundary dragging");
assert.match(html, /Incomplete Recipe Graph/, "standalone Browser warns before saving disconnected Modules");
assert.match(html, /Connect before saving/, "standalone Browser labels disconnected Modules");
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

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
assert.equal(scripts.length, 2, "standalone Recipe workbench must include shared and editor scripts");
scripts.forEach(script => assert.doesNotThrow(() => new Function(script), "standalone Recipe client script must parse"));
const graph = new Function(`${scripts[0]}; return RecipeGraph;`)();
assert.deepStrictEqual(graph.terms, {
  recipe:"Recipe", module:"Module", modules:"Modules", connection:"Connection", connections:"Connections",
  input:"Input", output:"Output", repeat:"Repeat group", loop:"Loop connection"
});
assert.equal(graph.repeatBadge({ mode:"repeat", count:{ kind:"fixed", value:1000 } }), "x1000");
assert.equal(graph.repeatBadge({ mode:"repeat", count:{ kind:"dynamic" } }), "xK");
assert.equal(graph.moduleTemplates.script.kind, "pkm.step.script/v1");
assert.deepStrictEqual(graph.organizedPositions([
  { nodeId:"prepare", dependsOn:[] },
  { nodeId:"finish", dependsOn:[{ from:"prepare" }] }
], { startX:24, startY:80, columnPitch:258, rowPitch:114 }), {
  prepare:{ x:24, y:80 },
  finish:{ x:24, y:194 }
});
assert.equal(graph.edgeRoute(120, 150, 120, 260, 400), "M 120 150 L 120 260");
const disconnectedNodes = [
  { nodeId:"prepare", dependsOn:[] },
  { nodeId:"finish", dependsOn:[{ from:"prepare" }] },
  { nodeId:"new-module", dependsOn:[] }
];
assert.deepStrictEqual([...graph.unconnectedNodeIds(disconnectedNodes, new Set(["new-module"]))], ["new-module"]);
assert.deepStrictEqual(graph.topology(disconnectedNodes, new Set(["new-module"])).roots.map(node => node.nodeId), ["prepare"]);
assert.deepStrictEqual(graph.topology(disconnectedNodes, new Set(["new-module"])).terminals.map(node => node.nodeId), ["finish"]);
assert.deepStrictEqual(graph.constrainBoundary("input", { x:90, y:200 }, [{ y:80, height:70 }], { x:20, y:18 }, { boundaryHeight:34, gap:28, minimumX:20 }), { x:90, y:18 });
assert.deepStrictEqual(graph.constrainBoundary("output", { x:90, y:20 }, [{ y:194, height:70 }], { x:20, y:312 }, { gap:48, minimumX:20 }), { x:90, y:312 });
assert.equal(graph.outputTop({ first:{ y:400 }, last:{ y:80 } }, [{ nodeId:"first" }, { nodeId:"last" }]), 512,
  "Output reflow follows the lowest Module, not only the graph terminal");
assert.notEqual(graph.presentation({ kind:"pkm.step.command/v1" }).key, graph.presentation({ kind:"pkm.step.script/v1" }).key,
  "functional Module kinds retain distinct semantic presentation");

console.log("recipe browser editor test: metadata, Graph/JSON, validation, save, and safe embedding OK");
