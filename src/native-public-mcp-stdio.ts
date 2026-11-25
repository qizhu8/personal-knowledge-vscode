import { Transform, type Readable, type Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** JSON.parse erases the int/float distinction required by the existing strict version argument. */
export function createNativePublicStdio(readable: Readable = process.stdin, writable: Writable = process.stdout) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  function checkedLine(line: string): string {
    try {
      const versions = new WeakMap<object, string>();
      const message = JSON.parse(line, function(key: string, value: unknown, context?: { source?: string }) {
        if (key === "version" && typeof value === "number" && context?.source && this && typeof this === "object")
          versions.set(this, context.source);
        return value;
      });
      if (message?.jsonrpc !== "2.0" || message.method !== "tools/call"
        || typeof message.id !== "string" && (typeof message.id !== "number" || !Number.isFinite(message.id))
        || !CallToolRequestSchema.safeParse(message).success) return line;
      const args = message.params?.arguments;
      const invalid = ["capability_read", "capability_call"].includes(message.params?.name)
        && args && typeof args === "object" && args.version === 1 && versions.get(args) !== "1";
      if (invalid) {
        // Keep invalidness on this message, not an ID side channel vulnerable to reuse/cancellation.
        args.version = null;
        return JSON.stringify(message);
      }
    } catch { /* The SDK reports malformed protocol messages. */ }
    return line;
  }
  const input = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      pending += decoder.write(chunk);
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        this.push(checkedLine(pending.slice(0, end)) + "\n"); pending = pending.slice(end + 1);
      }
      done();
    },
    flush(done) {
      pending += decoder.end();
      if (pending) this.push(checkedLine(pending));
      pending = ""; done();
    },
  });
  return {
    transport: new StdioServerTransport(input, writable),
    connectInput() { readable.pipe(input); },
    disconnectInput() {
      readable.unpipe(input); readable.pause(); input.destroy();
      pending = "";
    },
  };
}
