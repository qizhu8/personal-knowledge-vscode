import json
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[2])
from retrieval_mcp_owner import McpRetrievalOwner

owner = McpRetrievalOwner(sys.argv[1])
print(json.dumps({"event": "ready"}), flush=True)
for line in sys.stdin:
    if line.strip() == "close":
        try:
            print(json.dumps({"result": owner.close(timeout=120)}), flush=True)
        except Exception as error:
            print(json.dumps({"error": str(error)}), flush=True)
        break
