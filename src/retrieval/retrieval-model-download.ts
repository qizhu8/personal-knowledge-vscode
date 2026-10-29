import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

export interface DefaultRetrievalModel {
  repository: string;
  revision: string;
  manifest: { files: Record<string, { bytes: number; sha256: string }> };
}

export async function downloadRetrievalModel(
  model: DefaultRetrievalModel, directory: string, signal: AbortSignal,
  progress: (current: number, total: number) => void,
  request: typeof fetch = fetch,
): Promise<void> {
  if (model.repository !== "intfloat/multilingual-e5-small" || !/^[a-f0-9]{40}$/.test(model.revision)) {
    throw new Error("Only the pinned default embedding model is supported.");
  }
  const total = Object.values(model.manifest.files).reduce((sum, file) => sum + file.bytes, 0);
  let current = 0;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [name, file] of Object.entries(model.manifest.files)) {
    if (!name || name.split("/").some(part => !part || part === "." || part === "..")
      || name.includes("\\") || path.isAbsolute(name) || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid pinned model file inventory.");
    signal.throwIfAborted();
    progress(current, total);
    const idle = new AbortController();
    const stalled = () => idle.abort(new Error("Hugging Face download stalled for 60 seconds. Retry explicitly or import a local model directory."));
    let timer = setTimeout(stalled, 60_000);
    try {
      const response = await request(`https://huggingface.co/${model.repository}/resolve/${model.revision}/${name}`, {
        signal: AbortSignal.any([signal, idle.signal]),
      });
      if (!response.ok || !response.body) throw new Error(`Hugging Face download failed (${response.status}): ${name}`);
      const target = path.join(directory, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const output = await fs.promises.open(target, "wx", 0o600), digest = createHash("sha256");
      let size = 0, lastReport = 0;
      try {
        for await (const chunk of response.body) {
          clearTimeout(timer); timer = setTimeout(stalled, 60_000);
          signal.throwIfAborted();
          size += chunk.byteLength;
          if (size > file.bytes) throw new Error(`Downloaded model file exceeds its pinned size: ${name}`);
          digest.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) offset += (await output.write(chunk, offset)).bytesWritten;
          current += chunk.byteLength;
          if (Date.now() - lastReport >= 250) { progress(current, total); lastReport = Date.now(); }
        }
      } finally { await output.close(); }
      if (size !== file.bytes || digest.digest("hex") !== file.sha256) throw new Error(`Downloaded model checksum or size mismatch: ${name}`);
      progress(current, total);
    } finally { clearTimeout(timer); }
  }
}
