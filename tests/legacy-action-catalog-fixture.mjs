import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { originalDigest } from "../dist/domain/action-compiler-validation.js";
import { originalActionCompilerFixtures as original } from "./action-compiler-original-fixtures.mjs";

const file = JSON.stringify({ dependencies: {}, casts: {}, examples: [],
  ...JSON.parse(original.moduleSetFile) }, null, 2) + "\n";
export const portableActionManifest = structuredClone(original.moduleSet);
portableActionManifest.files[`definitions/${original.example.action_id}.json`] = createHash("sha256").update(file).digest("hex");
delete portableActionManifest.package_hash;
portableActionManifest.package_hash = originalDigest(portableActionManifest);

export function portableActionArchive(manifest = portableActionManifest, options = {}) {
  return execFileSync("python3", ["-c", `
import base64,io,json,sys,zipfile
request=json.load(sys.stdin)
result=io.BytesIO()
with zipfile.ZipFile(result,"w",compression=zipfile.ZIP_DEFLATED) as z:
 z.writestr("manifest.json",json.dumps(request["manifest"]))
 for path,content in request["files"].items(): z.writestr(path,content)
 for path,content in request["options"].get("binary",{}).items(): z.writestr(path,base64.b64decode(content))
 if request["options"].get("duplicate"): z.writestr("manifest.json","{}")
 if request["options"].get("traversal"): z.writestr("../outside","bad")
sys.stdout.buffer.write(result.getvalue())
`], { input: JSON.stringify({ manifest, files: {
    [`definitions/${original.example.action_id}.json`]: file, ...options.files,
  }, options }), env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
}
