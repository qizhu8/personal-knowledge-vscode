import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

test("the actual UI wait observes a 68-second model48 settlement within its declared execution budget", () => {
  const program = String.raw`
import ast,json,sys
source=ast.parse(open(sys.argv[1],encoding="utf8").read())
stage=next(node for node in source.body if isinstance(node,ast.FunctionDef) and node.name=="stage")
class Clock:
 def __init__(self):self.ticks=0
 def sleep(self,_):self.ticks+=1
class Progress:
 def __init__(self,clock,ready):self.clock=clock;self.ready=ready
 def __truediv__(self,_):return self
 def read_text(self):return json.dumps({"stage":"native-chat-resolve" if self.clock.ticks>=self.ready else "native-model-execution"})
def check(rounds,ready,accept):
 clock=Clock()
 scope={"fixture":{"nativeModels":True,"nativeModelRounds":rounds},"root":Progress(clock,ready),"time":clock,"json":json}
 exec(compile(ast.Module(body=[stage],type_ignores=[]),"<actual-installed-ui>","exec"),scope)
 try:scope["stage"]("native-chat-resolve")
 except AssertionError:
  if accept:raise
 else:
  if not accept:raise AssertionError("Unexpectedly accepted a late stage")
check(48,680,True)
check(48,960,False)
check(31,680,False)
`;
  execFileSync(process.env.PKM_TEST_PYTHON || "python3",
    ["-I", "-B", "-c", program, new URL("./installed-ui.py", import.meta.url).pathname],
    { timeout: 10000, stdio: "pipe" });
});

test("the actual runner ceiling does not terminate model48 before its existing 95-second execution budget", async () => {
  const source = await readFile(new URL("./installed-test-runner.cjs", import.meta.url), "utf8");
  const wrapper = source.slice(source.indexOf("exports.run = async"));
  for (const [rounds, shouldTimeout] of [[48, false], [31, true]]) {
    let settle;
    const work = new Promise(resolve => { settle = resolve; });
    const timers = new Map(), writes = [];
    let nextId = 0;
    const exports = {};
    runInNewContext(wrapper, {
      exports, run: () => work,
      process: { env: { PKM_HOST_INSTALLED_FIXTURE: JSON.stringify({
        root: "/private-model-fixture", nativeModels: true, nativeModelRounds: rounds,
      }) } },
      setTimeout: (callback, delay) => { timers.set(++nextId, { callback, delay }); return nextId; },
      clearTimeout: id => timers.delete(id),
      join: (...parts) => parts.join("/"),
      writeFile: async (...args) => { writes.push(args); },
    });
    const pending = exports.run();
    const outcome = pending.then(() => "complete", () => "timeout");
    for (const timer of timers.values()) if (timer.delay <= 100000) timer.callback();
    settle();
    assert.equal(await outcome, shouldTimeout ? "timeout" : "complete");
    assert.equal(writes.length, shouldTimeout ? 1 : 0);
    assert.equal(timers.size, 0);
  }
});
