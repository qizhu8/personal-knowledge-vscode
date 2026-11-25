import { originalActionFixture } from "./legacy-action-original-fixture.mjs";

export const originalPureActionOracleProgram = `
import ast,json,sys,types
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from action_modules import ModuleRuntime
source=Path(sys.argv[1])/"action_runtime.py"
tree=ast.parse(source.read_text(encoding="utf-8"))
registration,=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=="register_action_tools"]
names={"action_templates","action_definition_check","action_graph_check"}
nodes=[node for node in registration.body if isinstance(node,ast.FunctionDef) and node.name in names]
if len(nodes)!=len(names): raise ValueError("Original closed Action handlers changed")
factory=ast.parse("def close(runtime):\\n return {}").body[0]
factory.body=nodes+[ast.Return(value=ast.Dict(
 keys=[ast.Constant(value=node.name) for node in nodes],
 values=[ast.Name(id=node.name,ctx=ast.Load()) for node in nodes]))]
scope={}
exec(compile(ast.fix_missing_locations(ast.Module(body=[factory],type_ignores=[])),str(source),"exec"),scope)
modules=ModuleRuntime.__new__(ModuleRuntime)
modules.registry=Path.cwd()/"private-workspace"/"actions"
modules.root=Path.cwd()/"private-workspace"/".pkm"/"state"/"actions"
handlers=scope["close"](types.SimpleNamespace(modules=modules))
resources=Path(sys.argv[1]).absolute()
sealed=resources.parent
class PrivateBoundary(RuntimeError): pass
def owned(path):
 try:
  absolute=Path(path).absolute()
  return absolute.is_relative_to(resources) or absolute.is_relative_to(sealed/"dist")
 except (TypeError,ValueError): return False
def audit(event,args):
 if event=="open" and not isinstance(args[0],int) and not owned(args[0]):
  raise PrivateBoundary("Original requested private or external file IO")
 if event.startswith("socket.") or event in {"subprocess.Popen","os.system","os.exec","os.posix_spawn","os.fork","os.forkpty"}:
  raise PrivateBoundary("Original requested process or network authority")
def profile(frame,event,arg):
 if event=="call" and frame.f_globals.get("__name__")=="pathlib" and frame.f_code.co_name in {
  "exists","stat","lstat","is_file","is_dir","is_symlink","open","read_text","read_bytes","iterdir","glob","rglob","resolve"}:
  path=frame.f_locals.get("self")
  if path is not None and not owned(path):
   raise PrivateBoundary("Original requested private workspace metadata")
sys.addaudithook(audit)
result=[]
for case in json.load(sys.stdin):
 sys.setprofile(profile)
 try:
  value=modules.components() if case.get("fixture")=="component-contracts" else handlers[case["tool"]](**case["arguments"])
  result.append({"result":value})
 except PrivateBoundary as error:
  result.append({"boundary":str(error)})
 except Exception as error:
  result.append({"error":{"type":type(error).__name__,"message":str(error)}})
 finally:
  sys.setprofile(None)
print(json.dumps(result,allow_nan=False))
`;

export function originalPureActionOracle(directory, cases) {
  if ((process.env.PKM_ACTION_SOURCE_IDENTITY ?? "compiler-capture-v1") !== "compiler-capture-v1")
    throw new Error("Pure Action oracle requires the actual sealed Original 4.0.22, not the frozen-v2 fixture.");
  return originalActionFixture(directory).json(originalPureActionOracleProgram, [], JSON.stringify(cases));
}
