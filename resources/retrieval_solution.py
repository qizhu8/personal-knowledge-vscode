"""PKM's offline solution import entry point; no model dependencies are loaded."""

import argparse
import json
from pathlib import Path
import sys
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path)
    args = parser.parse_args()
    try:
        from adaptive_skill_retrieval.solution_package import import_package
        result = import_package(args.archive, args.state / "solutions")
        print(json.dumps({"ok": True, "package_id": result["package_id"],
                          "name": result["manifest"]["name"]}))
        return 0
    except (ImportError, OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
