import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { upgradeLegacyRetrievalLearningSnapshot } from "../dist/legacy-retrieval-learning-upgrade.js";

test("original predecessor/prefix learner schemas upgrade only in memory with exact original opt-in and legacy-gradient reset semantics", async () => {
  const fixtures = JSON.parse(execFileSync("python3", ["-c", `
import ast,hashlib,importlib.util,json,math,os,re,secrets,sqlite3,threading
from pathlib import Path
from types import SimpleNamespace
source=Path("resources/retrieval_solutions.py")
node,=[n for n in ast.parse(source.read_text()).body if isinstance(n,ast.ClassDef) and n.name=="RetrievalLearning"]
namespace=dict(globals(),os=SimpleNamespace(chmod=lambda *_:None))
exec(compile(ast.Module(body=[node],type_ignores=[]),"<independent-original-migration>","exec"),namespace)
class Root:
 def __truediv__(self,_):return ":memory:"
class Learner(namespace["RetrievalLearning"]):
 def connect(self):return database
fixtures=[]
for modelwidth,callwidth,optin,version,missingquery in [(9,11,False,False,False),(11,14,True,False,False),(14,19,True,True,False),(9,11,False,False,True)]:
 database=sqlite3.connect(":memory:")
 learner=Learner(Root())
 response={"ok":True,"model_invoked":True,"semantic_status":"ready","route":"semantic",
  "model_attempt_package_id":"a"*64,"corpus_revision":"original-corpus",
  "hits":[{"source_id":"pkm://notes/Original","score":.9},{"source_id":"pkm://notes/Other","score":.1}]}
 learner.configure(True);learner.observe(response,2.5,query="private-original-query")
 learner.feedback(response["retrieval_id"],["pkm://notes/Original"],True,"user")
 for table,width in [("models",modelwidth),("calls",callwidth)]:
  names=[row[1] for row in database.execute("PRAGMA table_info("+table+")")]
  for column in reversed(names[width:]):database.execute("ALTER TABLE "+table+" DROP COLUMN "+column)
 if not optin:database.execute("DELETE FROM settings WHERE key='online_learning_opt_in_version'")
 if not version:database.execute("DELETE FROM settings WHERE key='learner_version'")
 database.execute("UPDATE models SET slope=99,bias=88,samples=42,safe_streak=42")
 if missingquery:database.execute("DROP TABLE query_judgments")
 database.commit()
 names=["settings","models","calls","query_judgments"]
 order={"settings":"key","models":"context","calls":"id","query_judgments":"context,query_key"}
 raw={"columns":{name:[row[1] for row in database.execute("PRAGMA table_info("+name+")")] for name in names},
      "tables":{name:[] if missingquery and name=="query_judgments" else [list(row) for row in database.execute("SELECT * FROM "+name+" ORDER BY "+order[name])] for name in names}}
 Learner(Root())
 expected={name:[list(row) for row in database.execute("SELECT * FROM "+name+" ORDER BY "+order[name])] for name in names}
 fixtures.append({"raw":raw,"expected":expected,"optin":optin,"version":version})
 database.close()
print(json.dumps(fixtures))
`], { cwd: resolve(import.meta.dirname, "../legacy"), encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }));
  for (const fixture of fixtures) {
    const result = await upgradeLegacyRetrievalLearningSnapshot(fixture.raw);
    assert.deepEqual(result, fixture.expected);
    assert.equal(result.settings.find(row => row[0] === "salt")[1], fixture.raw.tables.settings.find(row => row[0] === "salt")[1]);
    assert.equal(result.settings.find(row => row[0] === "enabled")[1], fixture.optin ? "true" : "false");
    if (!fixture.version) {
      assert.equal(result.models[0][4], 4);
      assert.equal(result.models[0][5], -2);
      assert.equal(result.models[0][7], 0);
      assert.equal(result.calls[0][8], null);
      assert.equal(result.calls[0][9], null);
    }
  }
  const raw = fixtures[0].raw;
  for (const attack of [
    { ...raw, columns: { ...raw.columns, models: [...raw.columns.models, "arbitrary"] } },
    { ...raw, tables: { ...raw.tables, settings: raw.tables.settings.filter(row => row[0] !== "salt") } },
    { ...raw, tables: { ...raw.tables, settings: [...raw.tables.settings, ["unrecognized", "value"]] } },
    { ...fixtures[1].raw, columns: { ...fixtures[1].raw.columns, query_judgments: [] },
      tables: { ...fixtures[1].raw.tables, query_judgments: [] } },
  ]) await assert.rejects(upgradeLegacyRetrievalLearningSnapshot(attack));
});
