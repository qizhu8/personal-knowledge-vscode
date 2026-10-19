"""Deterministic stand-in model for tools/simulate.py smoke tests (stdin JSON request -> stdout text)."""
import json
import sys

request = json.load(sys.stdin)
system, user = request["messages"][0]["content"], request["messages"][-1]["content"]
if "organize the memory" in system:
    data = json.loads(user)
    text = data["current_input"]
    skills = next((t["alias"] for t in data["topics"] if "Skill" in t["label"]), None)
    if skills and ("上面" in text or "Skill" in text):
        print(json.dumps({"focus": [skills], "reason": "refers to the Skills review"}))
    else:
        print(json.dumps({"focus": ["new:1"], "new": [{"key": "new:1", "label": "Skill review" if "Skill" in text else text[:30]}]}))
elif "record what one conversation" in system:
    data = json.loads(user)
    print(json.dumps({"statements": [{"topic": "T1", "text": data["assistant"][:300], "status": "proposal"}]}))
elif "current understanding" in system:
    print(user[:400])
else:
    print("Design: separate trigger rules from descriptions and add an output validation step.")
