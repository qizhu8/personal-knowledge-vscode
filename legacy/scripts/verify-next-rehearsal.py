#!/usr/bin/env python3
"""Verify the experimental next-server payload in a VSIX; never install it."""
import hashlib
import json
import stat
import sys
import zipfile
import xml.etree.ElementTree as ET

PREFIX = "extension/next-runtime/"
REQUIRED = {
    "check.cjs",
    "server/dist/cli.js",
    "server/dist/legacy-import-cli.js",
    "server/dist/storage-worker.js",
    "server/compat/legacy-knowledge-mcp.py",
    "server/compat/legacy-note-inventory.py",
    "server/compute/worker.py",
    "server/browser/integration.mjs",
    "resources/note_inventory.py",
    "server/node_modules/zod/package.json",
    "server/node_modules/@modelcontextprotocol/sdk/package.json",
}


def verify(archive, extract=None):
    with zipfile.ZipFile(archive) as z:
        all_names = [item.filename for item in z.infolist()]
        if len(set(all_names)) != len(all_names):
            raise ValueError("Duplicate archive entries")
        package = json.loads(z.read("extension/package.json"))
        if (package.get("publisher"), package.get("name")) != ("pkm-experimental", "pkm-next-rehearsal"):
            raise ValueError("Incorrect experimental extension identity")
        if any(key in package for key in ("main", "browser", "activationEvents", "contributes", "extensionDependencies", "extensionPack")):
            raise ValueError("Experimental payload must not activate or register production features")
        xml = ET.fromstring(z.read("extension.vsixmanifest"))
        identities = [item for item in xml.iter() if item.tag.split("}")[-1] == "Identity"]
        if len(identities) != 1 or (identities[0].get("Publisher"), identities[0].get("Id")) != (
                "pkm-experimental", "pkm-next-rehearsal"):
            raise ValueError("VSIX identity does not match the experimental package")
        if identities[0].get("Version") != package.get("version"):
            raise ValueError("VSIX version differs from package")
        allowed = {"extension/package.json", "extension/readme.md", "extension/LICENSE.txt",
                   "extension.vsixmanifest", "[Content_Types].xml"}
        if any(not name.startswith(PREFIX) and name not in allowed for name in all_names):
            raise ValueError("Unexpected content outside experimental runtime")
        entries = [item for item in z.infolist() if item.filename.startswith(PREFIX)]
        names = [item.filename for item in entries]
        if len(set(names)) != len(names):
            raise ValueError("Duplicate runtime archive entries")
        for item in entries:
            parts = item.filename[len(PREFIX):].split("/")
            mode = item.external_attr >> 16
            if (not all(part and part not in (".", "..") and "\\" not in part for part in parts)
                    or item.is_dir() or stat.S_ISLNK(mode)):
                raise ValueError("Unsafe runtime archive entry: " + item.filename)
        manifest_name = PREFIX + "manifest.json"
        manifest = json.loads(z.read(manifest_name))
        if manifest.get("schema") != "pkm.next-rehearsal-runtime/v1" or manifest.get("experimental") is not True:
            raise ValueError("Not an experimental next runtime manifest")
        files = manifest.get("files")
        if not isinstance(files, dict) or not REQUIRED.issubset(files):
            raise ValueError("Missing required next runtime files")
        expected = {manifest_name, *(PREFIX + name for name in files)}
        if set(names) != expected:
            missing, extra = sorted(expected - set(names)), sorted(set(names) - expected)
            raise ValueError(f"Runtime inventory differs from VSIX entries; missing={missing[:10]}, extra={extra[:10]}")
        for name, digest in files.items():
            if not isinstance(digest, str) or hashlib.sha256(z.read(PREFIX + name)).hexdigest() != digest:
                raise ValueError("Runtime digest mismatch: " + name)
        if extract:
            for item in entries:
                z.extract(item, extract)
        print(f"Verified {len(files)} experimental runtime files in VSIX.")


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        raise SystemExit("usage: verify-next-rehearsal.py archive.vsix [isolated-extraction-directory]")
    verify(sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else None)
