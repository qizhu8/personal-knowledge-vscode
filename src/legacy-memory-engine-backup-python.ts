/** Native-owned entry command; the captured package and generated wrapper remain byte-identical. */
export const legacyMemorySnapshotPythonCommand = String.raw`
import hashlib
from pathlib import Path
import sys

source_path = Path(sys.argv.pop(1))
source = source_path.read_bytes()
if hashlib.sha256(source).hexdigest() != "5549ceb46dc3063c5acef71e913aec8446755533ed91080a4738571537440974":
    raise RuntimeError("Native snapshot adapter source oracle changed; no worker was opened.")
marker = "                elif method in mutations:\n"
extension = """                elif method == "backup_database":
                    destination = params.get("destination")
                    if not isinstance(destination, str) or not Path(destination).is_absolute():
                        raise MemoryError("Snapshot destination must be an absolute path.")
                    target = Path(destination)
                    if target.parent.resolve() != Path(args.database).parent.resolve() \\
                            or not target.name.startswith(".pkm-memory-snapshot-"):
                        raise MemoryError("Snapshot destination must be a native-owned runtime sibling.")
                    engine.backup(target)
                    result = {"identity": engine.identity, "schema": 2}
"""
program = source.decode("utf-8")
if program.count(marker) != 1:
    raise RuntimeError("Native snapshot adapter insertion point is not exact.")
program = program.replace(marker, extension + marker)
exec(compile(program, str(source_path), "exec"), {"__file__": str(source_path), "__name__": "__main__"})
`;
