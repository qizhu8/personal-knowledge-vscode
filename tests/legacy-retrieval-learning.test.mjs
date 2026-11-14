import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

test("exact original learner has only an in-memory fixed-table SQL authority, never filesystem connections or arbitrary schema", () => {
  const result = JSON.parse(execFileSync("python3", ["-c", `
import importlib.util,json,pathlib,sqlite3
path=pathlib.Path("next-server/compat/legacy-retrieval-learning.py").resolve()
spec=importlib.util.spec_from_file_location("native_original_learning",path)
adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
connections=[]
connect=sqlite3.connect
def memory_only(path,*args,**kwargs):
 assert path==":memory:"
 connections.append(path)
 return connect(path,*args,**kwargs)
sqlite3.connect=memory_only
_,state=adapter.execute(None,lambda learner:learner.configure(True))
assert set(state)=={"settings","models","calls","query_judgments"}
denied=[]
for sql in ["ATTACH DATABASE 'must-never-create-a-learning-file.sqlite' AS forbidden",
            "CREATE TABLE arbitrary(value TEXT)","ALTER TABLE calls ADD COLUMN arbitrary TEXT",
            "SELECT unknown_column FROM calls"]:
 try: adapter.execute(state,lambda learner:learner.connect().execute(sql))
 except sqlite3.DatabaseError:denied.append(sql)
 else:raise AssertionError("Original in-memory authority allowed unknown schema or filesystem: "+sql)
assert not pathlib.Path("must-never-create-a-learning-file.sqlite").exists()
try:adapter.execute(dict(state,arbitrary=[]),lambda _:None)
except ValueError:pass
else:raise AssertionError("unknown table snapshot accepted")
print(json.dumps({"connections":connections,"denied":len(denied)}))
`], { cwd: resolve(import.meta.dirname, "../legacy"), encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }));
  assert.equal(result.denied, 4);
  assert.equal(result.connections.length, 6);
  assert(result.connections.every(path => path === ":memory:"));
});
