import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Call only with synthetic project-local roots and the compiled original storage module. */
export async function createOriginalLibraryFixture(source, original) {
  const put = async (path, bytes, mode = 0o640) => {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), bytes);
    await chmod(join(source, path), mode);
  };
  await mkdir(join(source, "notes"), { recursive: true });
  original.setStorePath(source);
  await put("prompts/Ads/Accuracy/v9/base.jinja2", "BASE {{ Language }}\n");
  await put("prompts/Ads/Accuracy/v9/prompt.jinja2", "{# PROMPT_METADATA\ntitle: Accuracy\nnote:\nOriginal note\n#}\n{% extends 'base.jinja2' %}\n{{ PrivateInput }}\r\n");
  await put("prompts/Ads/Accuracy/v9/related/nested.bin", Buffer.from([0, 255, 128, 10]));
  await put("prompts/Ads/Accuracy/v9/README.md", "---\ninvalid: [yaml\n---\nTemplate documentation, not a Note.\n");
  await put("prompts/Ads/Accuracy/v10/prompt.jinja2", "{{ next_version }}\r\n");
  original.promptSaveVersionNote("Ads", "Accuracy", "v9", "prompt.jinja2", "Reviewed clone", "v9.1");
  await mkdir(join(source, "prompts/EmptyTask/Task/v1/empty"), { recursive: true });
  await put("prompts/Empty/.gitkeep", Buffer.alloc(0));
  await put("scripts/Tools/check.script", "#CS\nusing System;\n#ENDCS\n#PY\nimport os\n");
  const beforeMove = original.scriptGet("Tools/check.script");
  if (!original.scriptMove("Tools/check.script", "Archive")) throw new Error("Original Script move failed.");
  const script = original.scriptGet("Archive/check.script");
  const sidecarPath = original.scriptIdentityFile(script.path);
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
  sidecar.originalOpaqueMetadata = { preserve: ["not event history", 17] };
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n");
  await chmod(sidecarPath, 0o640);
  await put("scripts/run.sh", "#!/bin/sh\nprintf 'NEVER EXECUTE THIS FIXTURE\\n'\n", 0o751);
  const binary = Buffer.alloc(70013);
  for (let i = 0; i < binary.length; i++) binary[i] = i % 251;
  await put("scripts/binary.bin", binary);
  await put("scripts/empty.bin", Buffer.alloc(0));
  const prompt = original.promptGetFile("Ads", "Accuracy", "v9.1", "prompt.jinja2");
  const versions = original.promptGetAllVersionsOfFile("Ads", "Accuracy", "prompt.jinja2");
  return { beforeMove, script, sidecar, prompt, versions, binary, promptList: original.promptList() };
}
