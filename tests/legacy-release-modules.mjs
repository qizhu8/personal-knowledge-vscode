import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { runInThisContext } from "node:vm";
import { packageRoot, readOriginalSource } from "../scripts/migration.mjs";

const require = createRequire(import.meta.url);
const metadata = JSON.parse(await readFile(new URL("../migration/evidence/release-oracle-modules.json", import.meta.url), "utf8"));
const archive = "migration/evidence/release-oracle-modules.zip";
const archiveSha256 = "dcfa152b1de604627a44eb743495195cae64df2c4b6da3d5209236697f442398";
const sources = new Map(await Promise.all(metadata.members.map(async record => {
  assert.equal(record.member, `release-4.0.22/${record.path}`);
  assert.ok(record.path.startsWith("dist/") && record.path.endsWith(".js"));
  return [record.path, (await readOriginalSource(`${archive}!/${record.member}`, {
    root: packageRoot, kind: "source", sha256: record.sha256, archiveSha256,
  })).toString("utf8")];
})));
assert.equal(sources.size, metadata.members.length);

// These are compiled release modules, never substitutes for pinned TypeScript bytes.
export function originalReleaseModules(overrides = {}) {
  const modules = new Map();
  function load(path) {
    assert.ok(sources.has(path), `Module is outside the authenticated release closure: ${path}`);
    if (modules.has(path)) return modules.get(path).exports;
    const module = { exports: {} };
    modules.set(path, module);
    const filename = join(packageRoot, "legacy", path);
    const localRequire = name => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name.startsWith(".")) {
        const target = posix.normalize(posix.join(posix.dirname(path), name));
        return load(target.endsWith(".js") ? target : `${target}.js`);
      }
      return require(name);
    };
    runInThisContext(`(function(require,module,exports,__filename,__dirname){${sources.get(path)}\n})`, { filename })(
      localRequire, module, module.exports, filename, dirname(filename));
    return module.exports;
  }
  return source => {
    assert.match(source, /^src\/.+\.ts$/);
    return load(`dist/${source.slice(4, -3)}.js`);
  };
}
