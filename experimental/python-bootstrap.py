"""Pinned Python leaf executor used only inside an isolated managed package."""
from pathlib import Path
import runpy
import sys

generation = Path(__file__).resolve().parent
script = Path(sys.argv[1])
if (not script.is_absolute() or script.is_symlink()
        or not script.resolve().is_relative_to(generation / "runtime" / "next-server" / "compat")):
    raise SystemExit("Isolated Python executor refuses scripts outside its generation")
sys.dont_write_bytecode = True
sys.path.insert(0, str(generation / "runtime" / "site-packages"))
sys.argv = sys.argv[1:]
runpy.run_path(str(script), run_name="__main__")
