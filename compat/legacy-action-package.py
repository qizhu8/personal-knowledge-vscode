"""Decode an immutable, bounded portable Action package; never extract to disk."""
import base64
import io
import json
import sys
import zipfile


def decode(value):
    content = base64.b64decode(value, validate=True)
    if len(content) > 32 * 1024 * 1024:
        raise ValueError("Action package exceeds its byte budget.")
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) > 500 or len(set(names)) != len(names) or sum(entry.file_size for entry in entries) > 32 * 1024 * 1024:
            raise ValueError("Duplicate, oversized or excessive package entries.")
        for entry in entries:
            name = entry.filename
            if (entry.is_dir() or entry.flag_bits & 1 or (entry.external_attr >> 16) & 0o170000 == 0o120000
                    or name.startswith("/") or "\\" in name or ":" in name
                    or any(part in {"", ".", ".."} or part.startswith(".") for part in name.split("/"))):
                raise ValueError("Unsafe Action package member.")
        manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
        declared = manifest.get("files")
        if not isinstance(declared, dict) or set(names) != {"manifest.json"} | set(declared):
            raise ValueError("Undeclared Action package files.")
        files = {name: archive.read(name).decode("utf-8") for name in declared}
        return {"kind": "moduleSet", "manifest": manifest, "files": files, "enabled": False}


if __name__ == "__main__":
    print(json.dumps(decode(json.load(sys.stdin)["package"]), ensure_ascii=True))
