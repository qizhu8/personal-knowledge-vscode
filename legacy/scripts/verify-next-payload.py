#!/usr/bin/env python3
"""Verify the bundled next-server payload against the VSIX contents."""
import hashlib
import json
import stat
import sys
import zipfile

PREFIX = "extension/next-runtime/"
REQUIRED = {
    "check.cjs", "server/package.json", "server/package-lock.json",
    "server/dist/cli.js", "server/dist/legacy-import-cli.js",
    "server/dist/legacy-import.js", "server/dist/migration-preflight.js",
    "server/dist/rename-no-replace.js", "server/dist/file-mtime.js",
    "server/dist/managed-client-child.js", "server/dist/storage-worker.js",
    "server/compat/legacy-compact-mcp.py", "server/compat/legacy-note-inventory.py",
    "server/node_modules/zod/package.json", "server/node_modules/@modelcontextprotocol/sdk/package.json",
    "resources/note_inventory.py", "resources/action_components.js",
}


def verify(filename):
    with zipfile.ZipFile(filename) as archive:
        items = [item for item in archive.infolist() if item.filename.startswith(PREFIX)]
        names = [item.filename for item in items]
        if len(set(names)) != len(names):
            raise ValueError("Duplicate payload entry")
        for item in items:
            parts = item.filename[len(PREFIX):].split("/")
            if (not all(part and part not in (".", "..") and "\\" not in part for part in parts)
                    or item.is_dir() or stat.S_ISLNK(item.external_attr >> 16)):
                raise ValueError("Unsafe payload entry: " + item.filename)
        manifest = json.loads(archive.read(PREFIX + "manifest.json"))
        if (manifest.get("schema"), manifest.get("node"), manifest.get("entry")) != (
                "pkm.next-payload/v1", ">=22.18.0", "server/dist/managed-client-child.js"):
            raise ValueError("Invalid next-server payload contract")
        files = manifest.get("files")
        if not isinstance(files, dict) or not REQUIRED.issubset(files):
            raise ValueError("Required payload inventory missing")
        if set(names) != {PREFIX + "manifest.json", *(PREFIX + name for name in files)}:
            raise ValueError("Payload archive inventory mismatch")
        serialized = json.dumps(files, ensure_ascii=False, separators=(",", ":")).encode()
        if hashlib.sha256(serialized).hexdigest() != manifest.get("buildId"):
            raise ValueError("Payload inventory digest mismatch")
        for name, digest in files.items():
            if not isinstance(digest, str) or hashlib.sha256(archive.read(PREFIX + name)).hexdigest() != digest:
                raise ValueError("Payload digest mismatch: " + name)
        extension = json.loads(archive.read("extension/package.json"))
        server = json.loads(archive.read(PREFIX + "server/package.json"))
        lock = json.loads(archive.read(PREFIX + "server/package-lock.json"))
        if (manifest.get("extensionVersion") != extension.get("version")
                or manifest.get("serverVersion") != server.get("version")
                or manifest.get("serverVersion") != lock.get("packages", {}).get("", {}).get("version")
                or server.get("dependencies") != lock.get("packages", {}).get("", {}).get("dependencies")):
            raise ValueError("Payload version mismatch")
        for dependency in server.get("dependencies", {}):
            if "server/node_modules/" + dependency + "/package.json" not in files:
                raise ValueError("Missing direct dependency: " + dependency)
        for key, locked in lock["packages"].items():
            name = "server/" + key + "/package.json"
            if key.startswith("node_modules/") and name in files:
                installed = json.loads(archive.read(PREFIX + name))
                if installed.get("version") != locked.get("version"):
                    raise ValueError("Dependency differs from lock: " + key)
        print(f"Verified bundled next-server payload: {len(files)} pinned files.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify-next-payload.py archive.vsix")
    verify(sys.argv[1])
