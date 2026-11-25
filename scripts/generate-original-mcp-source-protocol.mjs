import { writeFile } from "node:fs/promises";
import { originalMcpSourceProtocol } from "../dist/original-mcp-source-protocol.js";

await writeFile(new URL("../dist/original-mcp-source-protocol.json", import.meta.url),
  JSON.stringify(originalMcpSourceProtocol) + "\n");
