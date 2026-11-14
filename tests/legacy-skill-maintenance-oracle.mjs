import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";

const repository = resolve(import.meta.dirname, "../legacy");
const source = await readFile(join(repository, "src/mcp/mcp.ts"), "utf8");
const match = /fs\.writeFileSync\(serverPy, `([\s\S]*?)`\);\s+fs\.writeFileSync\(reqTxt/.exec(source);
if (!match) throw Error("Original MCP Python generator missing.");
const original = new Function("UNIFIED_MCP_VERSION", "KNOWLEDGE_MCP_VERSION", "CHAT_MCP_VERSION",
  "RECIPE_MCP_VERSION", "AGENT_SESSION_MCP_VERSION", "storeFwd", "subscriptionCacheFwd",
  "retrievalStateFwd", "environmentsRegistryFwd", "context", `return \`${match[1]}\`;`)(
  "fixture", "fixture", "fixture", "fixture", "fixture", "/unused", "/unused", "/unused", "/unused",
  { extensionPath: repository });

export function originalSkillMaintenance({ root, tool, args, uuid, now, stamp }) {
  return JSON.parse(execFileSync("python3", ["-c", `
import ast,asyncio,datetime,hashlib,json,re,sys,time,urllib.parse,uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Optional,List
from fastmcp import FastMCP
request=json.load(sys.stdin)
tree=ast.parse(request["source"])
names={"_now","_parse","_name_of","_cat_of","_walk","_mtime","_arr","_year","_norm_cites",
       "_mcp_system_path","_skill_priority","_skill","_all_skills","_skill_id","_skill_by_id",
       "_skill_hash","_subscription_records","skill_feedback","propose_skill_update"}
body=[]
for node in tree.body:
 if isinstance(node,ast.FunctionDef) and node.name in names:
  node.decorator_list=[]
  body.append(node)
class Clock(datetime.datetime):
 calls=0
 @classmethod
 def utcnow(cls):
  cls.calls+=1
  if request.get("stamp") and cls.calls==1: return datetime.datetime.strptime(request["stamp"],"%Y%m%dT%H%M%SZ")
  return datetime.datetime.fromisoformat(request["now"])
namespace=dict(globals(),STORE=Path(request["root"]),SKILLS=Path(request["root"])/"skills",
 SUBSCRIPTIONS=Path(request["root"])/"subscriptions/cache",
 datetime=SimpleNamespace(datetime=Clock),uuid=SimpleNamespace(uuid4=lambda:uuid.UUID(request["uuid"])),
 _collector_post=lambda *args:None)
exec(compile(ast.Module(body=body,type_ignores=[]),"<independent-original-mcp>","exec"),namespace)
async def main():
 mcp=FastMCP("original-skill-maintenance")
 for name in ("skill_feedback","propose_skill_update"):
  mcp.tool(annotations={"readOnlyHint":False})(namespace[name])
 contracts={tool.name:tool.to_mcp_tool().model_dump(mode="json") for tool in await mcp.list_tools()}
 result=namespace[request["tool"]](**request["args"])
 artifacts={str(path.relative_to(request["root"])):path.read_text(encoding="utf-8")
   for directory in ("_feedback","_proposals") for path in (Path(request["root"])/directory).rglob("*") if path.is_file()}
 print(json.dumps({"value":json.loads(result),"text":result,"artifacts":artifacts,"contracts":contracts},ensure_ascii=False))
asyncio.run(main())
`], { encoding: "utf8", input: JSON.stringify({ root, tool, args, uuid, now, stamp, source: original }) }));
}
