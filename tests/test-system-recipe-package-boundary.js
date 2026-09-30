const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { builtInRecipeInventory } = require("../dist/workflows/project-model.js");

const root = path.join(__dirname, "..");
const expected = builtInRecipeInventory();
const packaged = JSON.parse(fs.readFileSync(path.join(root, "dist", "system-recipes.inventory.json"), "utf8"));

assert.strictEqual(packaged.schema, "pkm.system-recipes.inventory/v1");
assert.deepStrictEqual(packaged.recipes, expected, "post-build inventory must match the code-declared built-ins exactly");
assert(expected.length > 0);
assert.strictEqual(new Set(expected.map(recipe => recipe.key)).size, expected.length);
assert.strictEqual(new Set(expected.map(recipe => recipe.recipeId)).size, expected.length);
assert(expected.every(recipe => recipe.systemKind === "built-in"));
assert(expected.every(recipe => JSON.stringify(recipe.tags) === JSON.stringify(["System"])));
assert(expected.some(recipe => recipe.key === "create-agent-snapshot"));

const verifier = fs.readFileSync(path.join(root, "scripts", "verify-vsix-package.js"), "utf8");
assert.match(verifier, /Knowledge Root or personal Recipe payloads/);
assert.match(verifier, /extension\/dist\/system-recipes\.inventory\.json/);
assert.match(verifier, /packaged Recipe must carry the System tag/);

console.log("System Recipe package boundary test: inventory, System tags, and personal payload guard OK");
