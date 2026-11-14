import datetime, hashlib, json, re, urllib.parse, mimetypes, sqlite3, time, uuid
from pathlib import Path
from urllib.parse import quote
from typing import Optional, List


def _recipe_summary(recipe, score=0):
    nodes = ((recipe.get("definition") or {}).get("spec") or {}).get("nodes") or []
    metadata = recipe.get("metadata") or {}
    methodology = recipe.get("methodology") or {}
    return {
        "recipe_id": recipe.get("recipeId"),
        "name": recipe.get("name"),
        "description": recipe.get("description") or "",
        "category": recipe.get("category") or "",
        "metadata": {
            "applicable_functions": metadata.get("applicableFunctions") or [],
            "solution": metadata.get("solution") or "",
            "required_inputs": metadata.get("requiredInputs") or [],
            "expected_outputs": metadata.get("expectedOutputs") or [],
        },
        "scope": recipe.get("scope"),
        "project_id": recipe.get("projectId"),
        "revision": recipe.get("revision"),
        "executable_digest": recipe.get("executableDigest"),
        "methodology": ({
            "family": methodology.get("family"),
            "phase": methodology.get("phase"),
            "abstract": bool(methodology.get("abstract")),
            "capabilities": methodology.get("capabilities") or [],
            "artifacts": methodology.get("artifacts") or {"inputs": [], "outputs": []},
            "gates": methodology.get("gates") or [],
            "invariants": methodology.get("invariants") or [],
            "communication": methodology.get("communication") or {},
            "retrieval": methodology.get("retrieval") or {},
            "digest": recipe.get("methodologyDigest"),
        } if methodology else None),
        "node_count": len(nodes),
        "score": score,
    }

def related_recipes(store, knowledge_id, kind):
    """Derive reverse Recipe links from canonical node knowledge bindings."""
    if kind not in {"skill", "note"}:
        raise ValueError("Recipe knowledge link kind must be skill or note.")
    wanted = str(knowledge_id or "").strip("/").casefold()
    if not wanted:
        return []
    related = []
    for recipe in _project_recipes(Path(store)):
        matches = []
        for entry in recipe.get("nodeBindings") or []:
            if not isinstance(entry, dict):
                continue
            for binding in entry.get("bindings") or []:
                if (isinstance(binding, dict) and binding.get("kind") == kind
                        and str(binding.get("knowledgeId") or "").strip("/").casefold() == wanted):
                    matches.append({"node_id": entry.get("nodeId"), "usage": binding.get("usage")})
        if matches:
            summary = _recipe_summary(recipe)
            summary["bindings"] = matches
            related.append(summary)
    related.sort(key=lambda item: (item.get("name") or "", item.get("recipe_id") or ""))
    return related

_SKILL_STOP_WORDS = set("a an and are as at be by debug debugging for from how in into is it local member members name no not of on or problem substantial that the this to use using with workspace file files src code coding task issue".split())

def _now() -> str:
    return datetime.datetime.utcnow().isoformat()

def _parse(text):
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?", text, re.S)
    if not m:
        return {}, text
    fm = {}
    for line in m.group(1).splitlines():
        i = line.find(":")
        if i < 0:
            continue
        k = line[:i].strip()
        raw = line[i + 1:].strip()
        if not k:
            continue
        try:
            fm[k] = json.loads(raw)
        except Exception:
            fm[k] = raw.strip("\"'")
    return fm, text[m.end():]

def _name_of(key):
    return key.rsplit("/", 1)[-1]

def _cat_of(key):
    return key.rsplit("/", 1)[0] if "/" in key else ""

def _walk(root):
    out = []
    if not root.exists():
        return out
    for p in root.rglob("*.md"):
        rel = p.relative_to(root)
        if any(part.startswith(".") or part == "_assets" or part.lower().endswith(".assets") for part in rel.parts):
            continue
        out.append((p, rel.as_posix()[:-3]))
    return out

def _mtime(p):
    return datetime.datetime.utcfromtimestamp(p.stat().st_mtime).isoformat()

def _arr(x):
    return x if isinstance(x, list) else ([x] if x else [])

def _year(v):
    if isinstance(v, int): return v
    try: return int(str(v))
    except Exception: return None

def _norm_cites(v):
    out = []
    if isinstance(v, list):
        for e in v:
            if isinstance(e, str):
                if e.strip(): out.append({"paper": e.strip(), "note": ""})
            elif isinstance(e, dict):
                p = str(e.get("paper") or e.get("key") or "").strip()
                if p: out.append({"paper": p, "note": str(e.get("note") or e.get("comment") or "")})
    return out

def _paper(p, key):
    fm, body = _parse(p.read_text(encoding="utf-8"))
    return {"slug": key, "title": fm.get("title") or _name_of(key),
            "kind": "idea" if fm.get("kind") == "idea" else "paper",
            "group": (str(fm.get("group")).strip() if fm.get("group") else "") or "Papers",
            "pinned": fm.get("pinned") is True,
            "authors": _arr(fm.get("authors")), "year": _year(fm.get("year")),
            "topic": fm.get("topic") or "", "publisher": fm.get("publisher") or "",
            "tags": _arr(fm.get("tags")), "url": fm.get("url") or "", "file": fm.get("file") or "",
            "conclusions": _arr(fm.get("conclusions")), "cites": _norm_cites(fm.get("cites")),
            "category": _cat_of(key), "content": body, "updated_at": _mtime(p)}

def _all_papers():
    return [_paper(p, k) for p, k in _walk(PAPERS)]

def _paper_get(slug):
    p = PAPERS / (slug + ".md")
    return _paper(p, slug) if p.exists() else None

def _paper_resolver(all_p):
    by_key = {p["slug"].lower(): p["slug"] for p in all_p}
    by_title = {p["title"].lower(): p["slug"] for p in all_p}
    def r(ref):
        k = str(ref or "").lower()
        if k.endswith(".md"): k = k[:-3]
        return by_key.get(k) or by_title.get(k)
    return r

def _citation_counts(all_p):
    resolve = _paper_resolver(all_p)
    counts = {}
    for p in all_p:
        for c in p["cites"]:
            t = resolve(c["paper"])
            if t: counts[t] = counts.get(t, 0) + 1
    return counts

def _knowledge_read_key(identifier, legacy_key=None):
  if identifier and legacy_key and identifier != legacy_key:
    return "", json.dumps({"ok": False, "error": "id and legacy name/slug must identify the same item"})
  key = str(identifier or legacy_key or "").strip()
  if not key:
    return "", json.dumps({"ok": False, "error": "id is required"})
  return key, None

def _canonical_knowledge_id(identifier):
  return identifier.startswith(("pkm://knowledge/", "pkm://script/", "pkm://subscriptions/", "knowledge_", "script_"))

def _mcp_system_path(file_path):
    for candidate, root in [(Path(file_path).absolute(), STORE.absolute()),
                            (Path(file_path).resolve(), STORE.resolve())]:
        try:
            parts = candidate.relative_to(root).parts
        except ValueError:
            continue
        if len(parts) > 1 and parts[0].casefold() in {"notes", "skills", "prompts", "recipes"} and parts[1].casefold() == "system":
            return True
    return False

def _note(p, key):
    fm, body = _parse(p.read_text(encoding="utf-8"))
    identity = fm.get("knowledgeId")
    identity = identity if isinstance(identity, str) and re.fullmatch(r"knowledge_[a-f0-9]{24}", identity) else None
    board_file = p.with_name(p.stem + ".assets") / "pkm-todo-board.json"
    is_board = fm.get("documentKind") == "todo-board" or board_file.exists()
    return {"slug": key, "title": fm.get("title") or _name_of(key),
            "knowledge_id": identity,
            "documentKind": "todo-board" if is_board else "markdown",
            "type": fm.get("type") or "general", "tags": fm.get("tags") or [],
            "category": _cat_of(key), "content": body, "updated_at": _mtime(p),
            "read_only": _mcp_system_path(p)}

def _all_notes():
    return [_note(p, k) for p, k in _walk(NOTES)]

def _note_get(slug):
    p = NOTES / (slug + ".md")
    return _note(p, slug) if p.exists() else None

def _note_hash(row):
  value = json.dumps({"title": row["title"], "type": row.get("type", "general"),
            "category": row.get("category", ""), "tags": row.get("tags", []),
            "content": row.get("content", "")}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
  return hashlib.sha256(value.encode("utf-8")).hexdigest()

def _skill_priority(value, strict=False):
    normalized = str(value or "normal").strip().lower()
    if normalized in {"normal", "high", "highest"}:
        return normalized
    if strict:
        raise ValueError("Skill priority must be normal, high, or highest.")
    return "normal"

def _skill(p, key):
    fm, body = _parse(p.read_text(encoding="utf-8"))
    return {"name": fm.get("name") or _name_of(key), "description": fm.get("description") or "",
            "category": _cat_of(key), "tags": fm.get("tags") or [],
      "source_project": fm.get("source_project"), "recipe_required": fm.get("recipe_required") is True,
      "recipe_hint": str(fm.get("recipe_hint") or ""),
      "related_skills": _arr(fm.get("related_skills")),
      "priority": _skill_priority(fm.get("priority")),
      "content": body, "updated_at": _mtime(p), "read_only": _mcp_system_path(p), "_path": p}

def _skill_image_assets(row):
  skill_path = row.get("_path")
  if not isinstance(skill_path, Path):
    return []
  assets_root = skill_path.with_name(skill_path.stem + ".assets")
  if assets_root.is_symlink():
    raise ValueError("Skill image resource directory must be a non-symlink directory.")
  if not assets_root.exists():
    return []
  if not assets_root.is_dir():
    raise ValueError("Skill image resource directory must be a non-symlink directory.")
  image_extensions = {".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"}
  assets = []
  def walk(directory):
    for entry in sorted(directory.iterdir(), key=lambda item: item.name.casefold()):
      if entry.is_symlink():
        raise ValueError("Symbolic links are not allowed in Skill image resources.")
      if entry.is_dir():
        walk(entry)
      elif entry.is_file() and entry.suffix.lower() in image_extensions:
        relative = entry.relative_to(skill_path.parent).as_posix()
        reference = "/".join(urllib.parse.quote(part, safe="") for part in relative.split("/"))
        alt = entry.stem.replace("[", "&#91;").replace("]", "&#93;")
        assets.append({"path": relative, "markdown_reference": "![{}]({})".format(alt, reference),
          "media_type": mimetypes.guess_type(entry.name)[0] or "application/octet-stream",
          "size_bytes": entry.stat().st_size})
  walk(assets_root)
  return assets

def _all_skills():
    rows = [_skill(p, k) for p, k in _walk(SKILLS)]
    for record in _subscription_records():
      root = Path(record["cache_root"]) / "content" / "skills"
      for skill_path, key in _walk(root):
        row = _skill(skill_path, key)
        relative_path = key + ".md"
        encoded_path = "/".join(urllib.parse.quote(part, safe="") for part in relative_path.split("/"))
        pkm_path = "pkm://subscriptions/{}/{}/skills/{}".format(
          urllib.parse.quote(str(record.get("nodeId") or ""), safe=""),
          urllib.parse.quote(str(record.get("shareId") or ""), safe=""), encoded_path)
        source_priority = _skill_priority(record.get("priority"))
        effective_priority = max([row.get("priority", "normal"), source_priority],
                     key=lambda value: {"normal": 0, "high": 1, "highest": 2}.get(value, 0))
        row.update({"skill_id": pkm_path, "source": "subscription", "read_only": True,
          "priority": effective_priority,
          "provenance": {"subscription_id": record.get("subscriptionId"), "alias": record.get("alias"),
            "publisher": record.get("publisher"), "node_id": record.get("nodeId"), "share_id": record.get("shareId"),
            "revision": record.get("revision"), "synced_at": record.get("syncedAt"),
            "source_priority": _skill_priority(record.get("priority")), "pkm_path": pkm_path}})
        rows.append(row)
    return rows

def _skill_id(row):
  return row.get("skill_id") or ((row.get("category") or "") + "/" + row["name"]).strip("/")

def _skill_by_id(skill_id):
  wanted = str(skill_id or "").strip("/").casefold()
  for row in _all_skills():
    if _skill_id(row).casefold() == wanted or row["name"].casefold() == wanted:
      return row
  return None

def _skill_hash(row):
  value = json.dumps({"name": row["name"], "description": row.get("description", ""),
            "category": row.get("category", ""), "tags": row.get("tags", []),
            "recipe_required": row.get("recipe_required", False),
            "recipe_hint": row.get("recipe_hint", ""), "related_skills": row.get("related_skills", []),
            "content": row.get("content", "")}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
  return hashlib.sha256(value.encode("utf-8")).hexdigest()

def _skill_linkage(row):
  skill_id = _skill_id(row)
  recipes = related_recipes(STORE, skill_id, "skill")
  required = bool(row.get("recipe_required"))
  hint = str(row.get("recipe_hint") or row.get("description") or row.get("name") or "").strip()
  linkage = {"recipe_required": required, "recipe_hint": hint if required else str(row.get("recipe_hint") or ""),
             "related_skills": row.get("related_skills") or [], "related_recipes": recipes}
  if required:
    linkage["next_action"] = ({"kind": "use_related_recipe", "recipe_ids": [item["recipe_id"] for item in recipes]}
      if recipes else {"kind": "search_or_create_recipe", "search_query": hint,
        "search_tool": "recipe_search", "create_tool": "recipe_create_from_skill",
        "instruction": "Search for a qualified Recipe. If none matches, proactively design and create a reusable Library Recipe from this Skill before continuing."})
  return linkage

def _skill_source_key(row):
  if row.get("source") == "subscription":
    subscription_id = str((row.get("provenance") or {}).get("subscription_id") or "").strip()
    return "subscriber:" + subscription_id if subscription_id else "subscriber:unknown"
  return "pkm-personal"

def _skill_source_rank(row, source_priority=None):
  priority = source_priority or _router_source_priority()
  source_key = _skill_source_key(row)
  try:
    return priority.index(source_key)
  except ValueError:
    return len(priority)

def _index(skills, notes):
    try:
        c = sqlite3.connect(":memory:")
        c.execute("CREATE VIRTUAL TABLE s USING fts5(name, content, description, tokenize='trigram')")
        c.execute("CREATE VIRTUAL TABLE n USING fts5(slug, title, content, tokenize='trigram')")
        for r in skills:
            c.execute("INSERT INTO s VALUES(?,?,?)", [r["name"], r["content"], r["description"]])
        for r in notes:
            c.execute("INSERT INTO n VALUES(?,?,?)", [r["slug"], r["title"], r["content"]])
        return c
    except sqlite3.OperationalError:
        return None

def _search_typed_knowledge(query, content_type, limit, detail, tool_name, route="lexical"):
  if detail not in {"legacy", "standard"}:
    return json.dumps({"ok": False, "error": "detail must be legacy or standard"})
  if route not in {"lexical", "semantic", "dual", "graph", "hybrid"}:
    return json.dumps({"ok": False, "error": "Invalid route"})
  if route in {"semantic", "dual"} and detail == "legacy":
    detail = "standard"  # Zero hits and model/transport failure must retain their status.
  started_at = time.perf_counter()
  result = json.loads(search_knowledge(query, limit=limit, content_type_filter=[content_type], debug=detail == "legacy", route=route))
  _collect_search_invocation(tool_name, started_at,
      [hit.get("content_hash") or hit.get("source_id") for hit in result.get("hits") or []],
      bool(result.get("ok")), ["unified-retrieval"])
  if detail == "standard":
    return json.dumps(result, ensure_ascii=False)
  if not result.get("ok"):
    return None
  rows = []
  for hit in result.get("hits") or []:
    row = {key: hit.get(key) for key in ["rank", "score", "source_id", "source_revision", "content_hash",
           "content_type", "source_uri", "title", "description", "read_only", "provenance",
           "sources", "source_label", "path_evidence", "score_semantics"]}
    row.update({key: result.get(key) for key in ["search_mode", "semantic_status", "semantic_reason"]})
    key = str(hit.get("skill_id") or "").removeprefix(content_type + ":")
    if content_type == "skill":
      skill = _skill_by_id(key)
      row.update({"skill_id": key, "name": hit.get("title"), "skill_serving": result.get("skill_serving")})
      if skill:
        priority = _router_source_priority()
        row.update({"name": skill["name"], "category": skill["category"], "source": skill.get("source", "local"),
                    "source_key": _skill_source_key(skill), "source_rank": _skill_source_rank(skill, priority) + 1,
                    "priority": skill.get("priority", "normal"), "content_hash": _skill_hash(skill),
                    "linkage": _skill_linkage(skill)})
    elif content_type == "note":
      note = next((value for value in _all_notes() if value["slug"] == key), None)
      row.update({"slug": key, "type": note["type"] if note else (hit.get("metadata") or {}).get("type", "general")})
    elif content_type == "research":
      papers = _all_papers()
      paper = next((value for value in papers if value["slug"] == key), None)
      row.update({"slug": key, "year": paper.get("year") if paper else None,
                  "topic": paper.get("topic", "") if paper else "", "citation_count": _citation_counts(papers).get(key, 0)})
    rows.append(row)
  return json.dumps(rows, ensure_ascii=False)

def _search_papers_legacy(query, limit):
    limit = max(1, min(int(limit or 20), 100))
    q = query.lower(); started_at = time.perf_counter(); all_p = _all_papers(); counts = _citation_counts(all_p)
    hits = [p for p in all_p if q in p["title"].lower() or q in p["topic"].lower()
            or q in p["publisher"].lower() or q in " ".join(p["authors"]).lower()
            or q in " ".join(p["tags"]).lower() or q in str(p["year"] or "")]
    limited = hits[:limit]
    _collect_search_invocation("pkm.search_papers", started_at,
            [hashlib.sha256(p["slug"].encode("utf-8")).hexdigest() for p in limited],
            True, ["legacy-metadata-substring"])
    return json.dumps([{"slug": p["slug"], "title": p["title"], "year": p["year"],
                        "topic": p["topic"], "citation_count": counts.get(p["slug"], 0)} for p in limited])

def _router_config():
  try:
    return json.loads((RETRIEVAL_STATE / "router-config.json").read_text(encoding="utf-8"))
  except Exception:
    return {"enabledSolutions": ["copilot_default", "l1_online"],
        "sourcePriority": ["pkm-personal", "agent-native"]}

def _router_source_priority():
  configured = [str(item) for item in (_router_config().get("sourcePriority") or [])
          if str(item).strip()]
  result = []
  for source_id in configured + ["pkm-personal", "agent-native"]:
    if source_id not in result:
      result.append(source_id)
  return result

def _enabled_router_solutions():
  enabled = _router_config().get("enabledSolutions") or []
  return set(str(item) for item in enabled)

def _disabled_router_response(tool_name):
  return json.dumps({"ok": False, "disabled": True, "tool": tool_name,
             "fallback": "copilot_default",
             "message": "PKM Exact + BM25 is disabled. Continue with Copilot default search."})

def _skill_terms(value):
  text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(value or ""))
  return set(term for term in re.findall(r"[\w]{2,}", text.casefold(), re.UNICODE)
         if term not in _SKILL_STOP_WORDS and not term.isdigit())

def _subscription_records():
    rows = []
    if not SUBSCRIPTIONS.exists():
      return rows
    for metadata_path in SUBSCRIPTIONS.glob("*/*/_subscription.json"):
      try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["priority"] = _skill_priority(metadata.get("priority"))
        metadata["cache_root"] = str(metadata_path.parent)
        rows.append(metadata)
      except Exception:
        continue
    return rows

def _find_skill(name):
    for p, k in _walk(SKILLS):
        fm, _ = _parse(p.read_text(encoding="utf-8"))
        if (fm.get("name") or _name_of(k)) == name:
            return p, k
    return None, None

def _assert_mcp_writable(content_root, *file_paths):
    for file_path in file_paths:
        if file_path is None:
            continue
        if _mcp_system_path(file_path):
            raise PermissionError("System files and folders are read-only for Agent MCP writes.")
        try:
            Path(file_path).resolve().relative_to(content_root.resolve())
            Path(file_path).resolve().relative_to(STORE.resolve())
        except ValueError:
            raise PermissionError("MCP writes must remain inside their content directory.")

def _matches_retrieval_types(hit, requested):
  return (not requested or hit.get("content_type") in requested
          or ("subscription" in requested and ((hit.get("provenance") or {}).get("provider") == "broker"
              or str(hit.get("source_uri") or "").startswith("pkm://subscriptions/"))))

def _retrieval_hit_linkage(hit):
  content_type = hit.get("content_type")
  identifier = str(hit.get("skill_id") or "")
  if content_type == "skill" and identifier.startswith("skill:"):
    row = _skill_by_id(identifier[6:])
    return _skill_linkage(row) if row else None
  if content_type == "note" and identifier.startswith("note:"):
    return {"related_recipes": related_recipes(STORE, identifier[5:], "note")}
  return None

def list_papers(topic: Optional[str] = None) -> str:
    """List papers (optionally filtered by topic), sorted by citation count (popularity)."""
    all_p = _all_papers(); counts = _citation_counts(all_p)
    rows = [p for p in all_p if (not topic or p["topic"] == topic)]
    rows.sort(key=lambda p: (-(counts.get(p["slug"], 0)), -(p["year"] or 0), p["title"]))
    return json.dumps([{"slug": p["slug"], "title": p["title"], "year": p["year"],
                        "authors": p["authors"], "topic": p["topic"], "publisher": p["publisher"],
                        "tags": p["tags"], "citation_count": counts.get(p["slug"], 0)} for p in rows])

def list_research(topic: Optional[str] = None) -> str:
  """Canonical Research listing; preserves the existing Paper listing metadata and order."""
  return list_papers(topic=topic)

def get_research(id: str = "", slug: Optional[str] = None) -> str:
  """Read Research by stable source_id or relative slug; slug compatibility preserves the full paper record."""
  key, error = _knowledge_read_key(id, slug)
  if error:
    return error
  if _canonical_knowledge_id(key):
    return get_knowledge(key, content_type_filter=["research"])
  paper = _paper_get(key)
  if not paper:
    return f"Paper '{key}' not found. Use list_research or search_research to find it."
  paper["citation_count"] = _citation_counts(_all_papers()).get(key, 0)
  return json.dumps(paper)

def get_paper(slug: str = "", id: str = "") -> str:
  """Compatibility alias for get_research accepting both the historical slug and stable id."""
  return get_research(id=id, slug=slug or None)

def paper_graph(topic: Optional[str] = None, limit: int = 10, neighbors: bool = False) -> str:
    """Citation graph of the top papers. Returns {nodes, edges}: each edge is
    {from: cited_parent, to: citing_child, note}. 'limit' keeps the top-N by citations
    (optionally within 'topic'); set neighbors=true to also include directly-connected papers."""
    all_p = _all_papers(); resolve = _paper_resolver(all_p); counts = _citation_counts(all_p)
    by = {p["slug"]: p for p in all_p}
    filtered = [p for p in all_p if (not topic or p["topic"] == topic)]
    filtered.sort(key=lambda p: (-(counts.get(p["slug"], 0)), -(p["year"] or 0)))
    node_set = set(p["slug"] for p in filtered[:max(1, limit)])
    if neighbors:
        for s in list(node_set):
            p = by.get(s)
            if not p: continue
            for c in p["cites"]:
                t = resolve(c["paper"])
                if t: node_set.add(t)
            for q in all_p:
                for c in q["cites"]:
                    if resolve(c["paper"]) == s: node_set.add(q["slug"])
    nodes = [{"key": by[s]["slug"], "title": by[s]["title"], "year": by[s]["year"],
              "topic": by[s]["topic"], "citation_count": counts.get(s, 0),
              "conclusions": by[s]["conclusions"]} for s in node_set if s in by]
    edges = []
    for p in all_p:
        if p["slug"] not in node_set: continue
        for c in p["cites"]:
            t = resolve(c["paper"])
            if t and t in node_set:
                edges.append({"from": t, "to": p["slug"], "note": c["note"]})
    return json.dumps({"nodes": nodes, "edges": edges, "total": len(filtered), "shown": len(nodes)})

def get_note(id: str = "", slug: Optional[str] = None) -> str:
  """Read a Note by stable source_id or relative slug; the old slug parameter remains accepted."""
  key, error = _knowledge_read_key(id, slug)
  if error:
    return error
  if _canonical_knowledge_id(key):
    return get_knowledge(key, content_type_filter=["note"])
  r = _note_get(key)
  if not r:
    return f"Note '{key}' not found. Use list_notes or search_notes to find it."
  if r["documentKind"] == "todo-board":
    return json.dumps({"slug": r["slug"], "title": r["title"], "documentKind": "todo-board",
                      "message": "Use note_work_items to read authoritative items and note_work_item_command to modify them. Markdown is not task authority."})
  return json.dumps({"slug": r["slug"], "content_hash": _note_hash(r), "title": r["title"], "content": r["content"],
                     "type": r["type"], "tags": r["tags"], "category": r["category"],
                     "read_only": r.get("read_only", False), "updated_at": r["updated_at"],
                     "linkage": {"related_recipes": related_recipes(STORE, r["slug"], "note")}})

def list_skills(category: Optional[str] = None) -> str:
    """List personal skills, optionally filtered by category (a slash-separated folder path)."""
    rows = _all_skills()
    if category:
        rows = [r for r in rows if r["category"] == category]
    rows.sort(key=lambda r: (r["category"], r["name"]))
    return json.dumps([{"skill_id": _skill_id(r), "name": r["name"], "description": r["description"],
              "category": r["category"], "tags": r["tags"],
              "priority": r.get("priority", "normal"),
              "source": r.get("source", "local"), "read_only": r.get("read_only", False),
              "provenance": r.get("provenance")} for r in rows], ensure_ascii=False)

def get_skill(id: str = "", interaction_id: str = "", name: Optional[str] = None) -> str:
  """Read a Skill and return ready-to-insert Markdown references for its existing image assets when available."""
  key, error = _knowledge_read_key(id, name)
  if error:
    return error
  if _canonical_knowledge_id(key):
    result = json.loads(get_knowledge(key, content_type_filter=["skill"]))
    if result.get("ok"):
      row = None
      for candidate in (result.get("skill_id"), result.get("source_uri")):
        row = _skill_by_id(str(candidate or "").removeprefix("skill:"))
        if row:
          break
      result["image_assets"] = _skill_image_assets(row) if row else []
      result["image_reference_format"] = "Embed image_assets[].markdown_reference in Skill Markdown; references are relative to the Skill file and point to existing assets. This tool does not upload image bytes."
      _collector_post("skill_load", interaction_id or str(uuid.uuid4()), {"skill": {
          "content_hash": result.get("content_hash"), "source": (result.get("provenance") or {}).get("provider"),
          "read_only": bool(result.get("read_only"))}})
    if result.get("ok") or not key.startswith("pkm://subscriptions/") or result.get("code") not in {None, "index-not-ready"}:
      return json.dumps(result, ensure_ascii=False)
  r = _skill_by_id(key)
  if not r:
    return f"Skill '{key}' not found. Use list_skills or search_skills to find it."
  result = {"skill_id": _skill_id(r), "content_hash": _skill_hash(r),
             "name": r["name"], "content": r["content"], "description": r["description"],
             "category": r["category"], "tags": r["tags"], "updated_at": r["updated_at"],
             "priority": r.get("priority", "normal"),
             "source": r.get("source", "local"), "read_only": r.get("read_only", False),
             "provenance": r.get("provenance"), "linkage": _skill_linkage(r),
             "image_assets": _skill_image_assets(r),
             "image_reference_format": "Embed image_assets[].markdown_reference in Skill Markdown; references are relative to the Skill file and point to existing assets. This tool does not upload image bytes."}
  _collector_post("skill_load", interaction_id or str(uuid.uuid4()), {"skill": {
       "content_hash": result["content_hash"], "source": result["source"],
       "read_only": result["read_only"]}})
  return json.dumps(result)

def search_notes(query: str, limit: int = 20, detail: str = "legacy", route: str = "lexical") -> str:
    """Search Notes with lexical/semantic/dual routes. Standard returns status even for zero hits.

    The default legacy lexical shape preserves arrays and offline fallback; detail=standard
    returns the shared envelope. Semantic/dual always return the envelope.
    """
    standard = _search_typed_knowledge(query, "note", limit, detail, "pkm.search_notes", route=route)
    if standard is not None:
        return standard
    limit = max(1, min(int(limit or 20), 100))
    notes = _all_notes(); started_at = time.perf_counter()
    hits = []
    idx = _index([], notes)
    if idx is not None:
        try:
            slugs = [x[0] for x in idx.execute(
                "SELECT slug FROM n WHERE n MATCH ? ORDER BY rank LIMIT ?", [query, limit])]
            by = {r["slug"]: r for r in notes}
            hits = [by[s] for s in slugs if s in by]
        except sqlite3.OperationalError:
            hits = []
    if not hits:
        q = query.lower()
        hits = [r for r in notes if q in r["title"].lower() or q in (r["content"] or "").lower()][:limit]
    _collect_search_invocation("pkm.search_notes", started_at,
            [hashlib.sha256(r["slug"].encode("utf-8")).hexdigest() for r in hits],
            True, ["legacy-fts5", "substring-fallback"])
    return json.dumps([{"slug": r["slug"], "title": r["title"], "type": r["type"]} for r in hits])

def search_skills(query: str, limit: int = 20, detail: str = "legacy", route: str = "lexical") -> str:
    """Search only Skills. Semantic/dual routes always expose model status; lexical defaults preserve arrays and offline fallback."""
    standard = _search_typed_knowledge(query, "skill", limit, detail, "pkm.search_skills", route=route)
    if standard is not None:
        return standard
    limit = max(1, min(int(limit or 20), 100))
    skills = _all_skills(); started_at = time.perf_counter()
    hits = []
    idx = _index(skills, [])
    if idx is not None:
        try:
            names = [x[0] for x in idx.execute(
                "SELECT name FROM s WHERE s MATCH ? ORDER BY rank LIMIT ?", [query, limit])]
            by = {}
            for s in skills:
                by.setdefault(s["name"], s)
            hits = [by[n] for n in names if n in by]
        except sqlite3.OperationalError:
            hits = []
    if not hits:
        q = query.lower()
        hits = [s for s in skills if q in s["name"].lower()
                or q in (s["content"] or "").lower() or q in (s["description"] or "").lower()][:limit]
    source_priority = _router_source_priority()
    hits.sort(key=lambda skill: _skill_source_rank(skill, source_priority))
    _collect_search_invocation("pkm.search_skills", started_at,
            [_skill_hash(skill) for skill in hits], True,
            ["legacy-fts5", "substring-fallback"])
    return json.dumps([{"skill_id": _skill_id(s), "name": s["name"], "description": s["description"],
              "category": s["category"], "source": s.get("source", "local"),
              "source_key": _skill_source_key(s), "source_rank": _skill_source_rank(s, source_priority) + 1,
              "priority": s.get("priority", "normal"),
              "content_hash": _skill_hash(s),
              "skill_serving": None,
              "read_only": s.get("read_only", False), "provenance": s.get("provenance"),
              "linkage": _skill_linkage(s)}
               for s in hits], ensure_ascii=False)

def search_research(query: str, limit: int = 20, detail: str = "legacy", route: str = "lexical") -> str:
  """Search only Research. Semantic/dual routes always expose model status; lexical defaults preserve arrays and offline fallback."""
  standard = _search_typed_knowledge(query, "research", limit, detail, "pkm.search_research", route=route)
  if standard is not None:
    return standard
  return _search_papers_legacy(query, limit)

def search_papers(query: str, limit: int = 50, detail: str = "legacy", route: str = "lexical") -> str:
  """Compatibility alias for search_research; preserves the historical default limit of 50."""
  started_at = time.perf_counter()
  result = search_research(query, limit=limit, detail=detail, route=route)
  observed = json.loads(result)
  _collect_search_invocation("pkm.search_papers", started_at, [], not isinstance(observed, dict) or observed.get("ok") is True,
                            ["research-compatibility-alias"])
  return result

def list_subscriptions() -> str:
    """List physically isolated, machine-local PKM subscriptions and their provenance.
    This does not search or modify the user's local Knowledge Root."""
    rows = []
    for record in _subscription_records():
      rows.append({k: record.get(k) for k in ["subscriptionId", "alias", "priority", "publisher", "nodeId", "shareId", "revision", "collectionHash", "syncedAt"]})
    return json.dumps(rows, ensure_ascii=False)

def search_subscribed_content(query: str, content_type: Optional[str] = None,
                  alias: Optional[str] = None, limit: int = 20) -> str:
    """Explicitly search downloaded subscription caches. Results remain read-only and
    separate from local Skills/Notes/Papers/Prompts/Scripts/Packages/Servers."""
    started_at = time.perf_counter()
    needle = (query or "").casefold()
    wanted_type = (content_type or "").strip().lower()
    wanted_alias = (alias or "").casefold()
    results = []
    candidate_limit = min(500, max(100, max(1, min(limit, 100)) * 5))
    for record in _subscription_records():
      if len(results) >= candidate_limit:
        break
      if wanted_alias and wanted_alias not in str(record.get("alias") or record.get("publisher") or "").casefold():
        continue
      root = Path(record["cache_root"]) / "content"
      if not root.exists():
        continue
      for file_path in root.rglob("*"):
        if len(results) >= candidate_limit:
          break
        if not file_path.is_file() or file_path.name.endswith(".pkm-source.json"):
          continue
        relative = file_path.relative_to(root)
        item_type = relative.parts[0] if relative.parts else ""
        if wanted_type and item_type != wanted_type:
          continue
        try:
          text = file_path.read_text(encoding="utf-8")
        except Exception:
          continue
        if needle and needle not in str(relative).casefold() and needle not in text.casefold():
          continue
        index = text.casefold().find(needle) if needle else 0
        snippet = text[max(0, index - 100):index + max(160, len(needle) + 100)].replace("\n", " ")
        results.append({
          "node_id": record.get("nodeId"), "share_id": record.get("shareId"),
          "alias": record.get("alias") or record.get("publisher"), "content_type": item_type,
          "path": "/".join(relative.parts[1:]), "snippet": snippet,
          "source_priority": record.get("priority"),
          "revision": record.get("revision"), "synced_at": record.get("syncedAt"),
          "_path_match": bool(needle and needle in str(relative).casefold()),
        })
    results.sort(key=lambda item: (
      -((4 if item.pop("_path_match", False) else 0)
        + {"normal": 0, "high": 1, "highest": 2}[_skill_priority(item.get("source_priority"))]),
      str(item.get("alias") or "").casefold(), str(item.get("path") or "").casefold(),
    ))
    results = results[:max(1, min(limit, 100))]
    _collect_search_invocation("pkm.search_subscribed_content", started_at,
                  ["{}:{}:{}:{}".format(item.get("node_id"), item.get("share_id"), item.get("content_type"), item.get("path")) for item in results],
                  True, ["subscription-substring"])
    return json.dumps(results, ensure_ascii=False)

def get_subscribed_content(node_id: str, share_id: str, content_type: str, path: str) -> str:
    """Read one explicit subscribed cache item returned by search_subscribed_content.
    Returns content plus its publisher/subscriber provenance; never writes local content."""
    base = (SUBSCRIPTIONS / node_id / share_id / "content" / content_type).resolve()
    target = (base / path).resolve()
    if base not in target.parents or not target.is_file() or target.name.endswith(".pkm-source.json"):
      return json.dumps({"error": "Subscribed item not found."})
    try:
      content = target.read_text(encoding="utf-8")
      provenance_path = Path(str(target) + ".pkm-source.json")
      provenance = json.loads(provenance_path.read_text(encoding="utf-8")) if provenance_path.exists() else {}
      metadata_path = SUBSCRIPTIONS / node_id / share_id / "_subscription.json"
      metadata = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.exists() else {}
      provenance["sourcePriority"] = _skill_priority(metadata.get("priority"))
      return json.dumps({"content": content, "provenance": provenance}, ensure_ascii=False)
    except Exception as error:
      return json.dumps({"error": str(error)})

def get_subscribed_content_by_path(pkm_path: str) -> str:
    """Read a subscribed item directly from its canonical Copy Path URI."""
    try:
      parsed = urllib.parse.urlparse(str(pkm_path or ""))
      parts = [urllib.parse.unquote(part) for part in parsed.path.split("/") if part]
      if parsed.scheme != "pkm" or parsed.netloc != "subscriptions" or len(parts) < 4:
        raise ValueError("Invalid subscribed content path.")
      node_id, share_id, content_type = parts[:3]
      if content_type not in {"skills", "notes", "papers", "prompts", "scripts", "packages", "servers"}:
        raise ValueError("Invalid subscribed content type.")
      return get_subscribed_content(node_id, share_id, content_type, "/".join(parts[3:]))
    except Exception as error:
      return json.dumps({"error": str(error)})

def add_note(title: str, content: str, type: str = "general", tags: Optional[List[str]] = None,
             category: Optional[str] = None, slug: Optional[str] = None) -> str:
    """Create a new note. 'category' is a slash-separated path (e.g. Project/AutoLabeling/C2 Guideline)
    used to organize the note in the sidebar tree. 'type' is one of general/todo/done/observation/data-path.
    The note's identity ('slug') is its relative path without .md and is returned on success."""
    cat = _safe_cat(category or "")
    key = (cat + "/" + title) if cat else title
    if _note_get(key):
        return json.dumps({"error": f"Note '{key}' already exists. Use update_note instead."})
    new_slug = _note_write(key, title or key, content, type, tags or [], cat)
    return json.dumps({"ok": True, "slug": new_slug})

def update_note(slug: str, title: Optional[str] = None, content: Optional[str] = None,
                type: Optional[str] = None, category: Optional[str] = None, tags: Optional[List[str]] = None) -> str:
    """Update fields of an existing note by slug. Only provided fields are changed.
    Changing title/category moves the underlying file; the new slug is returned."""
    row = _note_get(slug)
    if not row:
        return json.dumps({"error": f"Note '{slug}' not found."})
    new_slug = _note_write(
        slug,
        title if title is not None else row["title"],
        content if content is not None else row["content"],
        type if type is not None else row["type"],
        tags if tags is not None else row["tags"],
        category if category is not None else row["category"],
    )
    return json.dumps({"ok": True, "slug": new_slug})

def add_skill(name: str, content: str, description: str = "", category: str = "",
              tags: Optional[List[str]] = None, source_project: str = "", recipe_required: bool = False,
              recipe_hint: str = "", related_skills: Optional[List[str]] = None,
              priority: str = "normal") -> str:
    """Create or overwrite a skill. 'category' is a slash-separated folder path
    (e.g. General/DLIS/docker); 'name' is the skill's unique identifier."""
    created = None
    existing = _skill_get(name)
    _skill_write(name, content, description, category, tags or [], source_project or None, created,
           recipe_required, recipe_hint, related_skills or [], priority)
    return json.dumps({"ok": True, "name": name})

def update_skill(name: str, content: Optional[str] = None, description: Optional[str] = None,
                 category: Optional[str] = None, tags: Optional[List[str]] = None,
                 recipe_required: Optional[bool] = None, recipe_hint: Optional[str] = None,
                 related_skills: Optional[List[str]] = None, priority: Optional[str] = None) -> str:
    """Update fields of an existing skill by name. Only provided fields are changed."""
    row = _skill_get(name)
    if not row:
        return json.dumps({"error": f"Skill '{name}' not found. Use add_skill to create it."})
    _skill_write(
        name,
        content if content is not None else row["content"],
        description if description is not None else row["description"],
        category if category is not None else row["category"],
        tags if tags is not None else row["tags"],
        row["source_project"],
        recipe_required=row["recipe_required"] if recipe_required is None else recipe_required,
        recipe_hint=row["recipe_hint"] if recipe_hint is None else recipe_hint,
        related_skills=row["related_skills"] if related_skills is None else related_skills,
        priority=row["priority"] if priority is None else priority,
    )
    return json.dumps({"ok": True, "name": name})

def add_paper(title: str, authors: Optional[List[str]] = None, year: Optional[int] = None,
              topic: str = "", publisher: str = "", tags: Optional[List[str]] = None,
              url: str = "", conclusions: Optional[List[str]] = None,
              cites: Optional[List[dict]] = None, category: str = "", content: str = "") -> str:
    """Create a paper. 'cites' is a list of {paper, note}: paper is a cited paper's title or slug,
    note explains how this paper uses it ('A cites B' means A is a child of B). 'category' is a
    slash-separated folder path; 'conclusions' is a list shown in the citation graph."""
    cat = _safe_cat(category or "")
    key = (cat + "/" + title) if cat else title
    if _paper_get(key):
        return json.dumps({"error": f"Paper '{key}' already exists. Use update_paper instead."})
    new = _paper_write(key, title, content, authors or [], year, topic, publisher, tags or [],
                       url, "", conclusions or [], cites or [], cat)
    return json.dumps({"ok": True, "slug": new})

def update_paper(slug: str, title: Optional[str] = None, authors: Optional[List[str]] = None,
                 year: Optional[int] = None, topic: Optional[str] = None, publisher: Optional[str] = None,
                 tags: Optional[List[str]] = None, url: Optional[str] = None,
                 conclusions: Optional[List[str]] = None, cites: Optional[List[dict]] = None,
                 category: Optional[str] = None, content: Optional[str] = None) -> str:
    """Update fields of an existing paper by slug. Only provided fields are changed."""
    p = _paper_get(slug)
    if not p:
        return json.dumps({"error": f"Paper '{slug}' not found."})
    new = _paper_write(slug,
        title if title is not None else p["title"],
        content if content is not None else p["content"],
        authors if authors is not None else p["authors"],
        year if year is not None else p["year"],
        topic if topic is not None else p["topic"],
        publisher if publisher is not None else p["publisher"],
        tags if tags is not None else p["tags"],
        url if url is not None else p["url"],
        p["file"],
        conclusions if conclusions is not None else p["conclusions"],
        cites if cites is not None else p["cites"],
        category if category is not None else p["category"])
    return json.dumps({"ok": True, "slug": new})

def skill_capabilities() -> str:
  """Discover the PKM secondary-Skill workflow for finding, using, and maintaining reusable knowledge."""
  return json.dumps({
    "ok": True,
    "capability": "pkm-skills",
    "workflow": ["skill_context", "get_skill for selected candidates", "perform task", "skill_feedback", "propose_skill_update"],
    "tools": ["skill_context", "skill_feedback", "propose_skill_update", "search_skills", "get_skill"],
    "maintenance_policy": "Use proposals for reusable changes; do not overwrite formal Skills automatically.",
  })

def skill_context(task: str, workspace: str = "", files: Optional[List[str]] = None,
          diagnostics: str = "", limit: int = 3, detail: str = "compact") -> str:
  """Find and activate the smallest relevant PKM Skill set for a substantial task.

  Call before coding, research, debugging, or operational workflows that may
  depend on personal conventions or domain knowledge. Compact output is the
  default; call get_skill with a selected skill_id to load its full body.
  """
  started_at = time.perf_counter()
  detail = str(detail or "compact").strip().lower()
  if detail not in {"compact", "full"}:
    return json.dumps({"ok": False, "error": "detail must be compact or full"})
  if "l1_online" not in _enabled_router_solutions():
    _collect_search_invocation("pkm.skill_context", started_at, [], False, ["copilot-fallback"])
    return _disabled_router_response("pkm.skill_context")
  if not str(task or "").strip():
    _collect_search_invocation("pkm.skill_context", started_at, [], False, ["metadata-threshold"])
    return json.dumps({"ok": False, "error": "task is required"})
  task_terms = _skill_terms(task)
  context_terms = _skill_terms(" ".join([str(workspace or ""), " ".join(files or []), str(diagnostics or "")]))
  normalized_context = re.sub(r"[^\w]+", " ", " ".join([
    str(task or ""), str(workspace or ""), " ".join(files or []), str(diagnostics or "")
  ]).casefold()).strip()
  boundary = _retrieval_request("/search", {
    "query": task,
    "limit": max(10, min(int(limit or 3) * 10, 100)),
    "content_type_filter": ["skill"],
    "request_id": str(uuid.uuid4()),
    "route": "lexical",
    "generation": {"mode": "latest-ready"},
    "scope": {"capability_id": "pkm.skill_context"},
    "deadline_at_ms": int(time.time() * 1000) + 5000,
  })
  boundary_rank = {
    str(hit.get("skill_id") or "").removeprefix("skill:"): index
    for index, hit in enumerate(boundary.get("hits") or [])
  } if boundary.get("ok") else {}
  rows = _all_skills()
  metadata_documents = []
  for candidate in rows:
    metadata_documents.append(_skill_terms(" ".join([
      candidate["name"], candidate.get("description") or "", candidate.get("category") or "",
      " ".join(candidate.get("tags") or []), candidate.get("source_project") or ""])))
  rare_limit = max(1, int(len(rows) * 0.05))
  rare_task_terms = set(term for term in task_terms
             if sum(1 for document in metadata_documents if term in document) <= rare_limit)
  source_priority = _router_source_priority()
  ranked = []
  for row in rows:
    fields = {
      "name": _skill_terms(row["name"]),
      "description": _skill_terms(row.get("description")),
      "tag": _skill_terms(" ".join(row.get("tags") or [])),
      "category": _skill_terms(row.get("category")),
      "source_project": _skill_terms(row.get("source_project")),
      "content": _skill_terms(row.get("content")),
    }
    weights = {"name": 12, "description": 8, "tag": 8, "category": 6, "source_project": 10}
    score, matched, metadata_hits = 0, [], set()
    for field, weight in weights.items():
      hits = task_terms & fields[field]
      if hits:
        score += weight * len(hits)
        metadata_hits.update(hits)
        matched.extend(field + ":" + term for term in sorted(hits))
    content_hits = task_terms & fields["content"]
    coverage = len(metadata_hits) / max(1, min(len(task_terms), 8))
    # Context may distinguish already-relevant Skills, but can never make an
    # unrelated Skill eligible on its own.
    context_metadata = set().union(*(context_terms & fields[field] for field in weights))
    # Body and execution context are tie-breakers only. They cannot increase
    # admission coverage or turn an unrelated Skill into a candidate.
    score += min(len(content_hits), 4) + min(len(context_metadata) * 2, 8)
    if _skill_id(row) in boundary_rank:
      score += max(1, 20 - boundary_rank[_skill_id(row)])
      matched.insert(0, "retrieval-boundary")
    matched.extend("content:" + term for term in sorted(content_hits)[:3])
    matched.extend("context:" + term for term in sorted(context_metadata)[:2])
    enough_metadata = len(metadata_hits) >= (1 if len(task_terms) <= 2 else 2)
    enough_coverage = coverage >= (0.5 if len(task_terms) <= 2 else 0.34)
    anchor_matched = not rare_task_terms or bool(metadata_hits & rare_task_terms)
    priority = row.get("priority") if row.get("priority") in {"high", "highest"} else "normal"
    identifiers = [row.get("name") or "", _skill_id(row)]
    exact_identifier = any(
      len(re.sub(r"[^\w]+", " ", str(identifier).casefold()).strip()) >= 4
      and re.sub(r"[^\w]+", " ", str(identifier).casefold()).strip() in normalized_context
      for identifier in identifiers
    )
    priority_admission = priority in {"high", "highest"} and len(metadata_hits) >= 2 and coverage >= 0.12 and anchor_matched
    if exact_identifier or (enough_metadata and enough_coverage and anchor_matched) or priority_admission:
      priority_boost = {"normal": 0, "high": 30, "highest": 60}[priority]
      score += priority_boost
      if exact_identifier:
        score += 80
        matched.insert(0, "exact-identifier")
      if priority != "normal":
        matched.insert(0, "priority:" + priority)
      source_rank = _skill_source_rank(row, source_priority)
      matched.insert(0, "source-priority:" + str(source_rank + 1))
      protected = exact_identifier or priority == "highest"
      ranked.append((0 if protected else 1, source_rank, score, coverage, len(metadata_hits), row, matched[:8]))
  frozen_serving = bool(boundary.get("skill_serving", {}).get("used"))
  ranked.sort(key=lambda item: (
    item[0], item[1],
    boundary_rank.get(_skill_id(item[5]), 1000) if frozen_serving else 0,
    -item[2], -item[3], -item[4], _skill_id(item[5]).casefold()))
  selected = ranked[:max(1, min(int(limit or 3), 5))]
  skills = []
  for index, (_, source_rank, score, coverage, metadata_count, row, reasons) in enumerate(selected):
    skills.append({"skill_id": _skill_id(row), "name": row["name"],
             "description": row.get("description", ""), "category": row.get("category", ""),
             "tags": row.get("tags", []), "source_project": row.get("source_project"),
             "source": row.get("source", "local"), "read_only": row.get("read_only", False),
             "source_key": _skill_source_key(row), "source_rank": source_rank + 1,
             "skill_priority": row.get("priority", "normal"),
             "provenance": row.get("provenance"),
             "content_hash": _skill_hash(row), "score": score, "task_coverage": round(coverage, 3),
             "priority": "required" if row.get("priority") == "highest" or (index == 0 and metadata_count >= 2 and coverage >= 0.5) else "recommended",
             "match_reason": reasons, "linkage": _skill_linkage(row)})
  no_match = not skills
  if detail == "compact":
    skills = [{
      key: value for key, value in skill.items()
      if key in {
        "skill_id", "name", "description", "source", "read_only", "source_key",
        "source_rank", "skill_priority", "provenance", "content_hash", "priority", "linkage",
        "task_coverage", "match_reason",
      } and value not in [None, [], {}]
    } for skill in skills]
  interaction_id = str(uuid.uuid4())
  candidates = []
  for index, (_, source_rank, score, coverage, metadata_count, row, reasons) in enumerate(ranked):
    candidates.append({"skill_id": _skill_id(row), "name": row["name"],
               "description": row.get("description", ""), "category": row.get("category", ""),
               "tags": row.get("tags", []), "source_project": row.get("source_project"),
               "source": row.get("source", "local"), "read_only": row.get("read_only", False),
               "source_key": _skill_source_key(row), "source_rank": source_rank + 1,
               "skill_priority": row.get("priority", "normal"),
               "provenance": row.get("provenance"),
               "content_hash": _skill_hash(row), "rank": index + 1, "score": score,
               "task_coverage": round(coverage, 3), "metadata_match_count": metadata_count,
               "match_reason": reasons, "linkage": _skill_linkage(row)})
  _collect_search_invocation("pkm.skill_context", started_at,
        [item.get("content_hash") for item in skills], True, ["metadata-threshold", "retrieval-boundary"],
        interaction_id=interaction_id)
  source_instruction = "Respect source_priority when relevant Skills overlap. Agent Native is host-managed and has no synthetic PKM candidate or score."
  if source_priority and source_priority[0] == "agent-native":
    source_instruction = "Evaluate applicable Agent Native Skills before the returned PKM candidates. Agent Native is host-managed and has no synthetic PKM candidate or score."
  response = {"ok": True, "interaction_id": interaction_id, "count": len(skills), "no_match": no_match,
             "retrieval": "summary", "retrieval_generation": boundary.get("ready_generation") if boundary.get("ok") else None,
             "skill_serving": boundary.get("skill_serving"),
             "source_priority": source_priority, "source_policy": source_instruction,
             "skills": skills,
             "instruction": source_instruction + " No relevant PKM Skill met the threshold; continue without a PKM Skill."
               if no_match else source_instruction + " Fetch only candidates you will apply, passing this interaction_id to get_skill and skill_feedback. Follow required Skills and linkage.next_action."}
  if detail == "full":
    response["task"] = task
  return json.dumps(response, ensure_ascii=False)

def delete_note(slug: str) -> str:
    """Move a note to PKM Trash and record durable deletion intent; never permanently unlink it."""
    p = NOTES / (slug + ".md")
    _assert_mcp_writable(NOTES, p)
    return json.dumps(trash_file(STORE, "notes", p.relative_to(NOTES).as_posix(), _KNOWLEDGE_NODE, _KNOWLEDGE_EXTENSION))

def delete_skill(name: str) -> str:
    """Move a Skill to PKM Trash and record durable deletion intent; never permanently unlink it."""
    p, _ = _find_skill(name)
    if p is not None:
        _assert_mcp_writable(SKILLS, p)
        return json.dumps(trash_file(STORE, "skills", p.relative_to(SKILLS).as_posix(), _KNOWLEDGE_NODE, _KNOWLEDGE_EXTENSION))
    return json.dumps({"ok": True, "name": name, "absent": True})

def delete_paper(slug: str) -> str:
    """Move a Research paper to PKM Trash and record durable deletion intent."""
    _assert_mcp_writable(PAPERS, PAPERS / (slug + ".md"))
    return json.dumps(trash_file(STORE, "papers", slug + ".md", _KNOWLEDGE_NODE, _KNOWLEDGE_EXTENSION))

def get_knowledge(id: str, content_type_filter: Optional[List[str]] = None) -> str:
  """Read the indexed revision by search result source_id, preserving its hash, type, provenance and read-only status."""
  if not str(id or "").strip():
    return json.dumps({"ok": False, "error": "id is required"})
  allowed = {"skill", "note", "research", "script", "recipe", "subscription"}
  if content_type_filter is not None and (not isinstance(content_type_filter, list) or not content_type_filter
                                         or any(value not in allowed for value in content_type_filter)):
    return json.dumps({"ok": False, "error": "Invalid content_type_filter"})
  return json.dumps(_retrieval_request("/get", {"source_id": id.strip(), "content_type_filter": content_type_filter}), ensure_ascii=False)

def get_script(id: str) -> str:
  """Read only a Script by stable source_id; this never executes the Script."""
  return get_knowledge(id, content_type_filter=["script"])

def search_knowledge(query: str, limit: int = 5, content_type_filter: Optional[List[str]] = None,
             request_id: str = "", debug: bool = False, route: str = "lexical",
             generation_mode: str = "latest-ready", generation: int = 0,
             graph_max_depth: int = 2, graph_max_nodes: int = 100, graph_max_edges: int = 500,
             graph_relations: Optional[List[str]] = None, graph_direction: str = "both",
             capability_source_ids: Optional[List[str]] = None, deadline_ms: int = 5000) -> str:
  """Search one typed index containing local Skills/Notes/Research/Scripts/Recipes and subscribed content.

  Routes lexical / semantic / dual are explicit. No embedding configuration means
  semantic_status=off without loading an encoder. Dual uses RRF and preserves path evidence.
  Query text is passed unchanged so mixed exact syntax remains observable. An explicit
  content_type_filter is strict; type words in query text are only soft preferences. Graph
  traversal is bounded and filtered before unavailable targets can enter the result.
  """
  started_at = time.perf_counter()
  if "l1_online" not in _enabled_router_solutions():
    _collect_search_invocation("pkm.search_knowledge", started_at, [], False, ["copilot-fallback"])
    disabled = json.loads(_disabled_router_response("pkm.search_knowledge"))
    disabled.update({"search_mode": route, "semantic_status": "unavailable", "semantic_reason": "Unified retrieval is disabled"})
    return json.dumps(disabled, ensure_ascii=False)
  if not str(query or "").strip():
    _collect_search_invocation("pkm.search_knowledge", started_at, [], False, ["exact", "bm25"])
    return json.dumps({"ok": False, "error": "query is required"})
  allowed = {"skill", "note", "research", "script", "recipe", "subscription"}
  if content_type_filter is not None and (not isinstance(content_type_filter, list) or not content_type_filter
                                         or any(str(value) not in allowed for value in content_type_filter)):
    _collect_search_invocation("pkm.search_knowledge", started_at, [], False, ["exact", "bm25"])
    return json.dumps({"ok": False, "error": "Invalid content_type_filter"})
  requested_limit = max(1, min(int(limit or 5), 100))
  if route not in {"lexical", "semantic", "dual", "graph", "hybrid"}:
    return json.dumps({"ok": False, "error": "Invalid route"})
  if generation_mode not in {"latest-ready", "exact", "minimum"}:
    return json.dumps({"ok": False, "error": "Invalid generation_mode"})
  if generation_mode != "latest-ready" and int(generation or 0) < 1:
    return json.dumps({"ok": False, "error": "generation must be positive for exact or minimum policy"})
  if graph_direction not in {"forward", "backlink", "both"}:
    return json.dumps({"ok": False, "error": "Invalid graph_direction"})
  deadline_at_ms = int(time.time() * 1000) + max(1, min(int(deadline_ms or 5000), 300000))
  result = _retrieval_request("/search", {
    "query": query, "limit": min(100, max(requested_limit, requested_limit * 5)),
    **({"output_limit": requested_limit} if route in {"semantic", "dual"} else {}),
    "content_type_filter": content_type_filter, "request_id": request_id,
    "route": route,
    "generation": {"mode": generation_mode, **({"generation": int(generation)} if generation_mode != "latest-ready" else {})},
    "scope": {"capability_id": "mcp.search_knowledge", "source_ids": capability_source_ids},
    "graph": {
      "max_depth": max(1, min(int(graph_max_depth or 2), 32)),
      "max_nodes": max(1, min(int(graph_max_nodes or 100), 10000)),
      "max_edges": max(1, min(int(graph_max_edges or 500), 50000)),
      "relations": graph_relations, "direction": graph_direction,
    },
    "deadline_at_ms": deadline_at_ms,
  })
  if not result.get("ok"):
    result = {**result, "search_mode": route, "semantic_status": "unavailable",
              "semantic_reason": result.get("error") or "Retrieval worker unavailable"}
  if result.get("ok"):
    def priority_multiplier(hit):
      metadata = hit.get("metadata") or {}
      provenance = hit.get("provenance") or {}
      priority = _skill_priority(metadata.get("source_priority") or metadata.get("priority")
                                 or provenance.get("source_priority"))
      return {"normal": 1.0, "high": 1.12, "highest": 1.24}[priority]
    result = dict(result)
    ranked_hits = [dict(hit) for hit in (result.get("hits") or [])
                   if _matches_retrieval_types(hit, content_type_filter)]
    ranked_hits.sort(key=lambda hit: (
      -(float(hit.get("score") or 0) * (1.0 if route in {"dual", "semantic"} else priority_multiplier(hit))),
      int(hit.get("rank") or 0),
      str(hit.get("skill_id") or ""),
    ))
    for index, hit in enumerate(ranked_hits[:requested_limit], 1):
      hit["rank"] = index
    result["truncated"] = bool(result.get("truncated")) or len(ranked_hits) > requested_limit
    result["limit_reached"] = bool(result.get("limit_reached")) or len(ranked_hits) >= min(100, requested_limit * 5)
    result["incomplete"] = bool(result.get("incomplete")) or result["truncated"] or result["limit_reached"]
    result["hits"] = ranked_hits[:requested_limit]
    result["result_count"] = len(result["hits"])
    result["groups"] = {}
    for hit in result["hits"]:
      result["groups"].setdefault(hit.get("content_type"), []).append(hit.get("source_id") or hit.get("skill_id"))
    result["counts"] = {kind: len(source_ids) for kind, source_ids in result["groups"].items()}
  result_ids = [hit.get("content_hash") or hit.get("skill_id") for hit in (result.get("hits") or [])]
  _collect_search_invocation("pkm.search_knowledge", started_at, result_ids, bool(result.get("ok")), ["exact", "bm25"])
  if debug or not result.get("ok"):
    return json.dumps(result, ensure_ascii=False)
  hits = []
  for hit in result.get("hits") or []:
    provenance = hit.get("provenance") or {}
    compact_provenance = {key: provenance.get(key) for key in
      ["provider", "broker", "subscription_id", "revision", "source_priority"] if provenance.get(key) is not None}
    compact_hit = {
      "rank": hit.get("rank"), "score": float(hit.get("score") or 0) if hit.get("score_semantics") == "rrf" else round(float(hit.get("score") or 0), 6),
      "skill_id": hit.get("skill_id"), "content_hash": hit.get("content_hash"),
      "source_id": hit.get("source_id"), "source_revision": hit.get("source_revision"),
      "score_components": hit.get("score_components") or {},
      "sources": hit.get("sources"), "source_label": hit.get("source_label"),
      "path_evidence": hit.get("path_evidence"), "score_semantics": hit.get("score_semantics"),
      "content_type": hit.get("content_type"), "source_uri": hit.get("source_uri"),
      "title": hit.get("title"), "description": hit.get("description"),
      "read_only": bool(hit.get("read_only")), "provenance": compact_provenance,
    }
    linkage = _retrieval_hit_linkage(hit)
    if linkage:
      compact_hit["linkage"] = linkage
    hits.append(compact_hit)
  compact = {key: result.get(key) for key in [
    "schema", "ok", "request_id", "corpus_revision", "ready_generation", "route", "query_intent", "exact_terms",
    "search_mode", "semantic_status", "semantic_reason", "solution", "skill_serving",
    "retrieval_id", "adaptive", "learning_error", "model_invoked",
    "lexical_anchors", "requested_content_types", "content_type_routing", "stale", "incomplete", "diagnostics",
    "truncated", "limit_reached", "result_count", "groups", "counts"]}
  compact["hits"] = hits
  return json.dumps(compact, ensure_ascii=False)

def search_scripts(query: str, limit: int = 20, detail: str = "legacy", route: str = "lexical") -> str:
  """Search only Scripts. Semantic/dual routes always expose model status; lexical defaults preserve legacy arrays."""
  result = _search_typed_knowledge(query, "script", limit, detail, "pkm.search_scripts", route=route)
  return result if result is not None else json.dumps({"ok": False, "error": "Subscriber retrieval worker unavailable"})

def skill_feedback(task: str, used_skills: List[str], outcome: str,
           observations: Optional[List[str]] = None, evidence: Optional[List[str]] = None,
           interaction_id: str = "") -> str:
  """Record which PKM Skills were used, the outcome, and reusable observations without modifying formal Skills."""
  directory = STORE / "_feedback"
  directory.mkdir(parents=True, exist_ok=True)
  entry = {"id": str(uuid.uuid4()), "created": _now(),
       "task_hash": hashlib.sha256(task.encode("utf-8")).hexdigest(),
       "used_skills": used_skills or [], "outcome": outcome,
       "observations": observations or [], "evidence": evidence or []}
  with (directory / "skill-usage.jsonl").open("a", encoding="utf-8") as handle:
    handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
  outcome_label = outcome if outcome in ["success", "failure", "partial", "cancelled"] else "other"
  _collector_post("outcome", interaction_id or entry["id"], {"feedback": {
      "used_skill_count": len(used_skills or []), "outcome": outcome_label,
      "observation_count": len(observations or []),
       "evidence_count": len(evidence or [])}})
  return json.dumps({"ok": True, "feedback_id": entry["id"]})

def propose_skill_update(skill_id: str, base_hash: str, reason: str,
             evidence: Optional[List[str]] = None, proposed_content: str = "",
             confidence: float = 0.0) -> str:
  """Create a reviewable PKM Skill maintenance proposal; never directly changes the formal Skill."""
  row = _skill_by_id(skill_id)
  if not row:
    return json.dumps({"ok": False, "error": "Skill not found", "skill_id": skill_id})
  if row.get("read_only"):
    return json.dumps({"ok": False, "error": "This Skill is read-only", "skill_id": skill_id})
  current_hash = _skill_hash(row)
  proposal_id = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
  directory = STORE / "_proposals" / "skills"
  directory.mkdir(parents=True, exist_ok=True)
  safe = re.sub(r"[^A-Za-z0-9._-]+", "-", _skill_id(row)).strip("-").lower() or "skill"
  target = directory / (proposal_id + "-" + safe + ".md")
  conflict = bool(base_hash and base_hash != current_hash)
  body = ["---", "proposal_id: " + proposal_id,
      "skill_id: " + json.dumps(_skill_id(row), ensure_ascii=False),
      "base_hash: " + json.dumps(base_hash or current_hash),
      "current_hash: " + json.dumps(current_hash),
      "conflict: " + ("true" if conflict else "false"),
      "confidence: " + str(max(0.0, min(float(confidence or 0), 1.0))),
      "created: " + _now(), "---", "", "# Skill Update Proposal", "",
      "## Reason", "", reason or "No reason supplied.", "", "## Evidence", ""]
  body.extend(["- " + item for item in (evidence or [])] or ["- No evidence supplied."])
  body.extend(["", "## Proposed Content", "", proposed_content or "No replacement content supplied.", ""])
  target.write_text("\n".join(body), encoding="utf-8")
  return json.dumps({"ok": True, "proposal_id": proposal_id,
             "proposal_path": str(target), "skill_id": _skill_id(row),
             "current_hash": current_hash, "conflict": conflict})

def retrieval_status() -> str:
  """Return the Subscriber-owned persistent retrieval worker and ready corpus revision."""
  return json.dumps(_retrieval_request("/status"), ensure_ascii=False)

def retrieval_feedback(retrieval_id: str, relevant_source_ids: List[str], complete: bool = False,
                       provenance: str = "model") -> str:
  """Submit complete relevance judgments for a model retrieval receipt.

  Include all known relevant canonical source IDs, including missed results.
  complete=true asserts complete judgments; task success, usage and silence are
  not relevance labels. Model self-evaluation trains the local online ranker and
  calibrator by default; embeddings remain frozen. Use provenance="user" only for
  explicit user judgments, which supersede model labels and replay training.
  """
  return json.dumps(_retrieval_request("/retrieval-feedback", {
    "retrieval_id": retrieval_id, "relevant_source_ids": relevant_source_ids, "complete": complete, "provenance": provenance,
  }), ensure_ascii=False)

def knowledge_file_trash(area: str, path: str, expected_sha256: str) -> dict:
        """Move an exact reviewed file to PKM Trash, only if its original bytes still match SHA-256."""
        if not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
            raise ValueError("A reviewed file SHA-256 is required.")
        return trash_file(store, area, path, node, extension_root, expected_sha256)

def note_work_items(slug: str) -> dict:
        """Read authoritative Todo Board items (or legacy Note blocks) and CAS digest.

        For Todo Boards the JSON document is authoritative; Markdown is not a task
        editing interface. Read before every command. No model or task runs.
        Reading never claims work. To take a task, use note_work_item_command
        with action='claim'; its authenticated identity becomes ownerId.
        Never directly edit the Board JSON, Markdown, ownership or audit files.
        """
        return work_items_request("work-items-read", slug)

def note_work_item_notes(query: str = "", limit: int = 20) -> dict:
        """Discover Notes with explicit Work Item blocks, on request only (1-1000 results).

        Query matches Note slug/title/description. Malformed Notes return explicit
        error entries, not silently empty items. No model or background scan runs.
        """
        return work_items_request("work-item-notes", "_discovery", query=query, limit=limit)

def note_work_item_command(slug: str, expected_digest: str, command: dict, worker_token: str | None = None) -> dict:
        """Apply one digest-CAS Work Item lifecycle command under the shared mutation lock.

        Commands: create/edit with item; claim/release/accept/reopen with id and
        optional reason; transition with id,state,optional reason,blockedReason,outcome,evidence.
        Default external identity is mcp:external. For a distinct external Agent,
        the user assigns external:copilot/claude/other:<id> in Board UI and copies
        a Board-scoped worker token to that Agent. Supply worker_token to use that
        identity, never a caller role override. Tokens grant worker policy only.
        This command API is the only supported Agent write path. Raw file edits
        and generic Markdown updates are not Todo editing interfaces.
        Rotating the token invalidates previous access. Native Chats have stable
        identities without a token.
        This compatibility endpoint retains restrictive worker policy; use the
        named Board APIs for contract/Story management and soft-delete/restore.
        Workers create unowned Planning items, claim them, edit only their own
        nonterminal evidence/links/verification/blockedReason, and transition them.
        Done requires outcome and evidence, not acceptance. Accept requires a user
        or an explicitly user-delegated reviewer and reason; reopen is user-only
        with reason. Release requires owner and reason. History is generated.
        OnHold requires reason and retains ownership. On dedicated Boards, claims,
        Active resumes and active reassignment enforce one WIP task per stable Agent
        across all Boards in the knowledge root. WORKITEM_FOCUS_CONFLICT changes nothing:
        explicitly put current work OnHold, submit real completion evidence, or defer
        the new task. Never silently suspend/complete previous work.
        Never blindly retry conflicts or lower acceptance criteria.
        """
        values = {"expectedDigest": expected_digest, "command": command}
        if worker_token is not None:
            values["workerToken"] = worker_token
        return work_items_request("work-item-command", slug, **values)

def note_work_item_upsert(slug: str, expected_digest: str, item: dict) -> dict:
        """Compatibility create/edit routed through worker lifecycle policy.

        Uses fixed identity mcp:external, not the low-level manual user-equivalent
        upsert API. New items must be unowned Planning without history/acceptance,
        projectId or reviewerIds; edits require ownership and preserve protected
        fields and generated history/decision. Use note_work_item_command to
        claim, transition or release. Read first; never blindly retry a conflict.
        """
        return work_items_request("work-item-upsert", slug, expectedDigest=expected_digest, item=item)

def todo_board_create(title: str, category: str = "") -> dict:
        """Create an empty structured Todo Board in Notes, not a Markdown checklist.

        Returns slug, items and digest. Use note_work_item_command to create and
        manage tasks; never write task blocks using add_note/update_note.
        Named add/update_workitem and add/update_userstory APIs manage contracts;
        acceptance delegation remains user-only. Existing documents are never
        overwritten or auto-converted.
        """
        slug = f"{category}/{title}" if category else title
        return work_items_request("todo-board-create", slug, title=title, category=category)

def knowledge_recovery_preview(evidence_directory: str) -> dict:
        """Verify a byte-preserving recovery plan. Never writes knowledge or overwrites existing files."""
        _, digest, rows = _plan(root, evidence_directory)
        return {
            "schema": "pkm.knowledge-recovery-preview/v1",
            "knowledge_root": str(root), "plan_sha256": digest,
            "counts": {status: sum(row[3] == status for row in rows)
                       for status in ("restore", "identical", "preserve-existing")},
            "files": [{"path": row[0]["path"], "status": row[3]} for row in rows],
        }

def knowledge_recovery_apply(evidence_directory: str, approved_plan_sha256: str) -> dict:
        """Restore missing files from an approved, hash-verified plan; preserve all existing files and audit each write."""
        directory, digest, rows = _plan(root, evidence_directory)
        if digest != approved_plan_sha256:
            raise ValueError("Recovery plan changed after approval.")
        report = {
            "schema": "pkm.knowledge-recovery-result/v1", "knowledge_root": str(root),
            "plan_sha256": digest, "started_at": datetime.now(timezone.utc).isoformat(),
            "restored": [], "identical": [], "preserved_existing": [],
        }
        report_path = directory / ("result-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f") + ".json")
        with report_path.open("x", encoding="utf-8") as audit:
            for entry, destination, content, status in rows:
                relative = entry["path"]
                _destination(root, relative)
                if status != "restore":
                    report["identical" if status == "identical" else "preserved_existing"].append(relative)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                _destination(root, relative)
                try:
                    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                except FileExistsError:
                    report["preserved_existing"].append(relative)
                    continue
                with os.fdopen(descriptor, "wb") as output:
                    output.write(content)
                    output.flush()
                    os.fsync(output.fileno())
                destination.chmod(0o755 if entry["mode"] == "100755" else 0o644)
                if _digest(destination.read_bytes()) != entry["sha256"]:
                    raise RuntimeError("Restored file failed byte verification: " + relative)
                report["restored"].append(relative)
                audit.seek(0)
                json.dump(report, audit, ensure_ascii=False, indent=2)
                audit.truncate()
                audit.flush()
                os.fsync(audit.fileno())
            report["completed_at"] = datetime.now(timezone.utc).isoformat()
            audit.seek(0)
            json.dump(report, audit, ensure_ascii=False, indent=2)
            audit.truncate()
            audit.flush()
            os.fsync(audit.fileno())
        return {"ok": True, "report": str(report_path),
                "restored": len(report["restored"]), "identical": len(report["identical"]),
                "preserved_existing": len(report["preserved_existing"])}

def action_definition_check(definition: dict):
        """Check definition/schema and pinned dependencies without saving, executing or granting; readiness is checked separately."""
        return runtime.modules.definition_check(definition)

action_definition_check.__annotations__['return'] = dict

def action_graph_check(graph: dict):
        """Validate typed ports, pinned blocks, parameters and acyclic connections without executing code."""
        return runtime.modules.graph_definition(graph)

action_graph_check.__annotations__['return'] = dict

def action_templates():
        """List public preinstalled wait/input/alias Actions and the pinned read-only polling template."""
        return runtime.modules.templates()

action_templates.__annotations__['return'] = dict

def action_template_create(action_id: str, parameters: dict):
        """Submit a template-based Action proposal for operator admission. Never registers or grants execution; wait for human approval before qualification."""
        return runtime.modules.template_create(action_id, parameters)

action_template_create.__annotations__['return'] = dict

def action_register(definition: dict):
        """Submit a versioned Action proposal, not a formal library registration. Return pending_operator_approval; ask the operator to approve it in Action Library and wait. The previous approved version is unchanged. No validation, invocation or automatic retry before approval."""
        return runtime.modules.register(definition)

action_register.__annotations__['return'] = dict

def action_proposals():
        """Read pending operator-review proposals. No registration, approval or execution; the previous approved Action remains in use."""
        return runtime.modules.proposal_list()

action_proposals.__annotations__['return'] = dict

def action_graph_save(graph: dict):
        """Submit a graphical composition proposal. It is not callable until operator admission and qualification."""
        return runtime.modules.graph_save(graph)

action_graph_save.__annotations__['return'] = dict

def action_get(action_id: str):
        """Read a stable Action definition and its current target-environment readiness."""
        definition = runtime.definition(action_id)
        return {**definition, "execution_contract": action_contract(definition), "availability": runtime.availability(action_id)
                if action_id in DEFINITIONS else runtime.modules.availability(action_id)}

action_get.__annotations__['return'] = dict

def action_module_sets():
        """List installed optional plugin packages without loading disabled definitions."""
        return runtime.modules.module_set_list()

action_module_sets.__annotations__['return'] = dict

def action_module_set_import(local_path: str):
        """Check and install a bounded package disabled; never import host credentials or validation."""
        return runtime.modules.module_set_import(local_path)

action_module_set_import.__annotations__['return'] = dict

def action_module_set_load(module_set_id: str, version: int, enabled: bool = True):
        """Enable or unload one immutable ModuleSet version; installation is not readiness."""
        return runtime.modules.module_set_load(module_set_id, version, enabled)

action_module_set_load.__annotations__['return'] = dict

def action_module_set_remove(module_set_id: str, version: int):
        """Remove only a disabled installed package version, never caller files or retained runs."""
        return runtime.modules.module_set_remove(module_set_id, version)

action_module_set_remove.__annotations__['return'] = dict

def action_artifact_import(local_path: str):
        """Borrow a regular file inside the user-configured workspace; GC never deletes the original."""
        return runtime.modules.import_artifact(local_path)

action_artifact_import.__annotations__['return'] = dict

def action_artifact_export(artifact_id: str, destination: str):
        """Export to a new user-owned file inside the selected workspace; never overwrite existing data."""
        return runtime.modules.export_artifact(artifact_id, destination)

action_artifact_export.__annotations__['return'] = dict

def knowledge_snapshot_status() -> dict:
        """List immutable local snapshot tags and daily schedule, with UTC and PST/PDT display."""
        return snapshots.status()

def knowledge_snapshot_create(reason: str = "manual") -> dict:
        """Snapshot active knowledge and privacy config in private Git, without changing the user's index or pushing. Excludes runtime state, Chat history, Actions and Recipes."""
        return snapshots.create(reason)

def knowledge_snapshot_configure(enabled: bool = True, local_time: str = "17:00",
                                     timezone: str = "America/Los_Angeles") -> dict:
        """Configure a persistent daily local snapshot. Time is HH:MM in an IANA zone; executions are recorded in UTC."""
        return snapshots.configure(enabled, local_time, timezone)

def knowledge_snapshot_restore_preview(tag: str) -> dict:
        """Preview restoring active knowledge to a dated tag. Does not alter knowledge; current privacy is preserved."""
        return snapshots.restore_preview(tag)

def knowledge_snapshot_restore_apply(preview_id: str, approved_sha256: str) -> dict:
        """Apply an unchanged approved preview, after a safety snapshot. Replaced/extra files go to PKM Trash with journal records."""
        return snapshots.restore_apply(preview_id, approved_sha256)

def asset_classify_preview() -> dict:
        """Read-only model-free rules and duplicate/correction review. No model calls or writes.
        Private assets are excluded. Review evidence with the user before explicit subset approval.
        Previews expire on MCP restart; no merge, deletion, move or autonomous consolidation.
        """
        value = invoke({'operation': 'preview'})
        if len(previews) >= 8:
            previews.pop(next(iter(previews)))
        previews[value['id']] = value
        return value

def asset_classify_apply(preview_id: str, proposal_ids: list[str]) -> dict:
        """After explicit user approval, apply only listed classification proposal IDs from a preview.
        Metadata-only frontmatter/sidecars, stale-hash skips, recoverable journal. Dedupe/corrections are review-only.
        """
        if preview_id not in previews or not proposal_ids:
            raise ValueError('An active preview and explicit approved proposal IDs are required.')
        return invoke({'operation': 'apply', 'preview': previews[preview_id], 'proposalIds': proposal_ids})

def asset_classify_rollback(journal_id: str) -> dict:
        """Restore exact pre-apply bytes from a journal; skip metadata edited since apply."""
        return invoke({'operation': 'rollback', 'journalId': journal_id})

def agent_session_capabilities() -> dict:
        """Explain PKM Agent Sessions: owned by PKM Chat; any agent may read Agent Snapshots."""
        return {
            "schema": SESSION_SCHEMA,
            "version": AGENT_SESSION_SCHEMA_VERSION,
            "owner": "pkm-chat",
            "external_sessions": "unsupported",
            "proactive": False,
            "tools": ["agent_session_snapshot_list", "agent_session_snapshot_read"],
            "use_when": [
                "the user pastes an Agent Snapshot Magic Code (PKM-SNAP-...)",
                "the user asks to continue or inspect work captured in an Agent Snapshot",
            ],
            "snapshot_read": "Read-only. Returns task, todos, checkpoints, the latest checkpoint state, Recipe run "
                             "states (PKM Chat Snapshots only) and recent conversation (PKM Chat Snapshots only). "
                             "It never creates an Agent Session.",
            "recovery": "To continue inside PKM, recover a Snapshot into a new PKM Chat from the Agent Snapshots panel.",
        }

def agent_session_snapshot_list() -> dict:
        """List immutable Agent Snapshots without exposing recovery verifiers or captured payloads."""
        directory = _snapshot_directory(store)
        recoveries = {}
        sessions_directory = store / ".pkm" / "state" / "agent-sessions"
        if sessions_directory.exists():
            for path in sessions_directory.glob("agent_session_*.json"):
                try:
                    session = json.loads(path.read_text(encoding="utf-8"))
                    snapshot_id = str((session.get("provenance") or {}).get("snapshotId") or "")
                    if snapshot_id:
                        recoveries[snapshot_id] = recoveries.get(snapshot_id, 0) + 1
                except (json.JSONDecodeError, OSError):
                    continue
        snapshots = []
        if directory.exists():
            for path in directory.glob("agent_snapshot_*.json"):
                try:
                    snapshot = json.loads(path.read_text(encoding="utf-8"))
                    if snapshot.get("schema") == SNAPSHOT_SCHEMA:
                        snapshot = _snapshot_encrypt_legacy(path, snapshot)
                        snapshots.append(_snapshot_summary(
                            snapshot, recoveries.get(str(snapshot.get("snapshotId") or ""), 0)))
                except (json.JSONDecodeError, OSError):
                    continue
        snapshots.sort(key=lambda item: item["createdAt"], reverse=True)
        return {"ok": True, "snapshots": snapshots}

def agent_session_snapshot_read(magic_code: str, recent_messages: int = 12) -> dict:
        """Read an Agent Snapshot's captured state by Magic Code without creating an Agent Session.

        Returns task, todos, checkpoints, latest checkpoint state, Recipe run states when present (PKM
        Chat Snapshots) and up to 0-50 recent conversation messages (PKM Chat Snapshots only).
        """
        if not 0 <= int(recent_messages) <= 50:
            raise ValueError("recent_messages must be between 0 and 50.")
        snapshot = _load_snapshot_by_magic(store, magic_code)
        payload = _snapshot_decrypt_payload(snapshot)
        if not _snapshot_payload_is_canonical(payload):
            raise ValueError("Agent Snapshot payload is not a canonical Session capture.")
        return _snapshot_read_projection(snapshot, payload, int(recent_messages))

API_SCHEMA = "pkm.recipe.api/v1"

RUN_SCHEMA = "pkm.recipe.run/v1"

DEFINITION_SCHEMA = "pkm.workflow.definition/v1"

COMMAND_NODE_KIND = "pkm.step.command/v1"

SCRIPT_NODE_KIND = "pkm.step.script/v1"

PIPELINE_NODE_KIND = "pkm.step.pipeline/v1"

NATIVE_NODE_KIND = "pkm.step.native/v1"

HUMAN_GATE_NODE_KIND = "pkm.gate.human/v1"

USAGE_SUMMARY_GROUP_LIMIT = 100

USAGE_SUMMARY_RUN_SCAN_LIMIT = 5000

def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

def _response(**values):
    return _json({"schema": API_SCHEMA, **values})

def _fingerprint(value):
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()

def _parse_json(value, label, expected_type=dict):
    try:
        parsed = json.loads(value or ("{}" if expected_type is dict else "null"))
    except json.JSONDecodeError as error:
        raise ValueError(label + " must be valid JSON: " + str(error)) from error
    if expected_type is not None and not isinstance(parsed, expected_type):
        raise ValueError(label + " must decode to " + expected_type.__name__)
    return parsed

def _subscribed_recipes(subscription_cache):
    root = Path(subscription_cache) if subscription_cache else None
    if root is None or not root.exists():
        return []
    recipes = []
    for metadata_path in root.glob("*/*/_subscription.json"):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        content_root = metadata_path.parent / "content" / "recipes"
        if not content_root.exists():
            continue
        for recipe_path in content_root.rglob("*.json"):
            if recipe_path.name.endswith(".pkm-source.json"):
                continue
            try:
                recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
                _validate_definition(recipe)
                if recipe.get("executableDigest") != _fingerprint(recipe.get("definition") or {}):
                    continue
            except (json.JSONDecodeError, OSError, ValueError):
                continue
            relative = recipe_path.relative_to(content_root).as_posix()
            node_id = str(metadata.get("nodeId") or metadata_path.parents[1].name)
            share_id = str(metadata.get("shareId") or metadata_path.parent.name)
            recipe["_subscription"] = {
                "pkmPath": "pkm://subscriptions/{}/{}/recipes/{}".format(
                    quote(node_id, safe=""), quote(share_id, safe=""),
                    "/".join(quote(part, safe="") for part in relative.split("/"))),
                "subscriptionId": metadata.get("subscriptionId"),
                "alias": metadata.get("alias"),
                "brokerName": metadata.get("brokerName"),
                "publisher": metadata.get("publisher"),
                "nodeId": node_id,
                "shareId": share_id,
                "revision": metadata.get("revision"),
            }
            recipes.append(recipe)
    return recipes

def _search(store, query, category, project_id, limit, task_contract, subscription_cache=None):
    terms = [term for term in str(query or "").lower().split() if term]
    category_lower = str(category or "").strip().lower()
    candidates = []
    available = [(recipe, False) for recipe in _project_recipes(store)]
    available.extend((recipe, True) for recipe in _subscribed_recipes(subscription_cache))
    for recipe, subscribed in available:
        if not subscribed and recipe.get("scope") != "global" and recipe.get("projectId") != project_id:
            continue
        recipe_category = str(recipe.get("category") or "")
        if category_lower and not recipe_category.lower().startswith(category_lower):
            continue
        nodes = ((recipe.get("definition") or {}).get("spec") or {}).get("nodes") or []
        metadata = recipe.get("metadata") or {}
        methodology = recipe.get("methodology") or {}
        methodology_artifacts = methodology.get("artifacts") or {}
        methodology_retrieval = methodology.get("retrieval") or {}
        methodology_communication = methodology.get("communication") or {}
        metadata_fields = [*(metadata.get("requiredInputs") or []), *(metadata.get("expectedOutputs") or [])]
        text = "\n".join(str(value or "") for value in [
            recipe.get("name"), recipe.get("description"), recipe_category,
            *(metadata.get("applicableFunctions") or []), metadata.get("solution"),
            *[field.get("name") for field in metadata_fields if isinstance(field, dict)],
            *[field.get("description") for field in metadata_fields if isinstance(field, dict)],
            *[node.get("nodeId") for node in nodes if isinstance(node, dict)],
            *[node.get("kind") for node in nodes if isinstance(node, dict)],
            methodology.get("family"), methodology.get("phase"),
            *(methodology.get("capabilities") or []),
            *(methodology_artifacts.get("inputs") or []),
            *(methodology_artifacts.get("outputs") or []),
            *(methodology.get("gates") or []),
            *(methodology.get("invariants") or []),
            methodology_communication.get("minimumAssurance"),
            *(methodology_communication.get("escalateOn") or []),
            *(methodology_retrieval.get("intents") or []),
            *(methodology_retrieval.get("terminology") or []),
            *(methodology_retrieval.get("operationalPoints") or []),
        ]).lower()
        if terms and not all(term in text for term in terms):
            continue
        name = str(recipe.get("name") or "").lower()
        score = (40 if category_lower and recipe_category.lower() == category_lower else 20 if category_lower else 0)
        score += 30 if query and str(query).lower() == name else 10 * sum(term in name for term in terms)
        score += 5 * sum(term in text for term in terms)
        summary = _recipe_summary(recipe, score)
        if subscribed:
            provenance = recipe["_subscription"]
            summary.update({"source": "subscription", "read_only": True, "requires_fork": True,
                            "original_recipe_id": summary["recipe_id"], "pkm_path": provenance["pkmPath"],
                            "provenance": provenance})
        candidates.append(summary)
    candidates.sort(key=lambda item: (-item["score"], item["name"] or "", item["recipe_id"] or ""))
    candidates = candidates[:max(1, min(int(limit or 10), 50))]
    if candidates:
        local_ids = [item["recipe_id"] for item in candidates if not item.get("read_only")]
        subscribed_paths = [item["pkm_path"] for item in candidates if item.get("read_only")]
        next_action = ({"kind": "qualify_recipe", "candidate_recipe_ids": local_ids,
                        "read_only_recipe_paths": subscribed_paths, "task_contract": task_contract}
                       if local_ids else
                       {"kind": "review_subscribed_recipe", "pkm_paths": subscribed_paths,
                        "instruction": "Read and explicitly fork or import the subscribed Recipe before execution.",
                        "task_contract": task_contract})
        return _response(ok=True, outcome="candidates", qualification="metadata-only-v1",
                         candidates=candidates,
                         next_action=next_action)
    requested_family = str(
        task_contract.get("methodologyFamily") or task_contract.get("family") or ""
    ).strip().lower() if isinstance(task_contract, dict) else ""
    local_available = [
        recipe for recipe, subscribed in available
        if not subscribed
        and (recipe.get("scope") == "global" or recipe.get("projectId") == project_id)
        and not (recipe.get("methodology") or {}).get("abstract")
    ]
    fallback_kind = ""
    fallback_recipes = []
    if requested_family:
        fallback_recipes = [
            recipe for recipe in local_available
            if str((recipe.get("methodology") or {}).get("family") or "").lower() == requested_family
        ]
        fallback_kind = "family-fallback" if fallback_recipes else ""
    if not fallback_recipes:
        fallback_recipes = [
            recipe for recipe in local_available
            if (recipe.get("methodology") or {}).get("family") == "universal-unknown-task"
        ]
        fallback_kind = "universal-fallback" if fallback_recipes else ""
    if fallback_recipes:
        fallback_candidates = [_recipe_summary(recipe, 0) for recipe in fallback_recipes]
        fallback_candidates.sort(key=lambda item: (item["name"] or "", item["recipe_id"] or ""))
        fallback_candidates = fallback_candidates[:max(1, min(int(limit or 10), 50))]
        return _response(
            ok=True,
            outcome=fallback_kind,
            qualification="methodology-fallback-v1",
            candidates=fallback_candidates,
            next_action={
                "kind": "qualify_recipe",
                "candidate_recipe_ids": [item["recipe_id"] for item in fallback_candidates],
                "task_contract": task_contract,
                "fallback": fallback_kind,
                "reason": (
                    "No exact metadata match; selected the requested Methodology family."
                    if fallback_kind == "family-fallback"
                    else "No exact or family match; selected the universal unknown-task fallback."
                ),
            },
        )
    return _response(ok=True, outcome="no-match", qualification="metadata-only-v1", candidates=[],
                     next_action={"kind": "design_recipe", "task_contract": task_contract,
                                  "reason": "No accessible metadata candidate matched. Recipe persistence requires the extension authoring bridge."})

def _execution_kind(node):
    if node.get("kind") != PIPELINE_NODE_KIND:
        return node.get("kind")
    config = node.get("config")
    executor = config.get("executor") if isinstance(config, dict) else None
    if not isinstance(executor, str) or executor not in {"command", "script"}:
        raise ValueError("Recipe Pipeline executor must be command or script.")
    return COMMAND_NODE_KIND if executor == "command" else SCRIPT_NODE_KIND

def _validate_definition(recipe):
    definition = recipe.get("definition") or {}
    if definition.get("schema") != DEFINITION_SCHEMA:
        raise ValueError("Only pkm.workflow.definition/v1 Recipes can run lazily.")
    spec = definition.get("spec") or {}
    nodes = spec.get("nodes") or []
    if not nodes:
        raise ValueError("Recipe has no nodes.")
    node_ids = {node.get("nodeId") for node in nodes if isinstance(node, dict)}
    if len(node_ids) != len(nodes) or None in node_ids:
        raise ValueError("Recipe node identities are invalid.")
    for node in nodes:
        if _execution_kind(node) not in {"pkm.step.noop/v1", COMMAND_NODE_KIND, SCRIPT_NODE_KIND, NATIVE_NODE_KIND, HUMAN_GATE_NODE_KIND,
                                    "pkm.subflow/v1"} or not isinstance(node.get("dependsOn"), list):
            raise ValueError("Recipe contains an unsupported v1 node.")
        if any(not isinstance(dependency, dict) for dependency in node["dependsOn"]):
            raise ValueError(
                "Recipe dependencies must be objects with a 'from' field, not node-id strings.")
        if any(dependency.get("from") not in node_ids for dependency in node["dependsOn"]):
            raise ValueError("Recipe dependency references an unknown node.")
        if node.get("kind") == "pkm.subflow/v1":
            config = node.get("config") or {}
            digest = config.get("executableDigest")
            if (not config.get("recipeId") or not isinstance(config.get("revision"), int)
                    or isinstance(config.get("revision"), bool) or config["revision"] < 1
                    or not isinstance(digest, str) or len(digest) != 64
                    or any(character not in "0123456789abcdef" for character in digest)):
                raise ValueError("Recipe subflow must pin an exact Recipe revision and SHA-256 digest.")
        if _execution_kind(node) == COMMAND_NODE_KIND:
            config = node.get("config") or {}
            if (not isinstance(config.get("program"), str) or not config["program"].strip()
                    or any(character in config["program"] for character in "\r\n\0")
                    or not isinstance(config.get("args"), list)
                    or any(not isinstance(argument, str) or "\0" in argument for argument in config["args"])):
                raise ValueError("Recipe command must use a program and an argv string list.")
        if _execution_kind(node) in {COMMAND_NODE_KIND, SCRIPT_NODE_KIND}:
            files = (node.get("config") or {}).get("files", [])
            if not isinstance(files, list) or any(not isinstance(value, str) or not value or "\0" in value for value in files):
                raise ValueError("Recipe resource files must be a list of nonempty references.")
        if _execution_kind(node) == COMMAND_NODE_KIND:
            config = node.get("config") or {}
            timeout = config.get("timeoutSeconds", 300)
            maximum = config.get("maxOutputBytes", 65536)
            if (not isinstance(timeout, int) or isinstance(timeout, bool) or timeout < 1 or timeout > 3600
                    or not isinstance(maximum, int) or isinstance(maximum, bool)
                    or maximum < 1024 or maximum > 1048576):
                raise ValueError("Recipe command timeout or output limit is invalid.")
            if config.get("cwd") is not None and (not isinstance(config["cwd"], str)
                                                   or not config["cwd"].strip()
                                                   or any(character in config["cwd"] for character in "\r\n\0")):
                raise ValueError("Recipe command cwd is invalid.")
        if _execution_kind(node) == SCRIPT_NODE_KIND:
            config = node.get("config") or {}
            runtime = config.get("runtime")
            script = config.get("script")
            environment_id = config.get("environmentId")
            if runtime not in {"bash", "powershell", "python"}:
                raise ValueError("Recipe script runtime is invalid.")
            if not isinstance(script, str) or not script.strip() or "\0" in script:
                raise ValueError("Recipe script content is required and cannot contain null characters.")
            arguments = config.get("args", [])
            if not isinstance(arguments, list) or any(
                    not isinstance(argument, str) or "\0" in argument for argument in arguments):
                raise ValueError("Recipe script args must be an argv string list.")
            if runtime == "python" and (not isinstance(environment_id, str) or not environment_id.strip()):
                raise ValueError("Recipe Python script requires a PKM environmentId.")
            if runtime != "python" and environment_id is not None:
                raise ValueError("Recipe environmentId is only valid for Python scripts.")
            timeout = config.get("timeoutSeconds", 300)
            maximum = config.get("maxOutputBytes", 65536)
            if (not isinstance(timeout, int) or isinstance(timeout, bool) or timeout < 1 or timeout > 3600
                    or not isinstance(maximum, int) or isinstance(maximum, bool)
                    or maximum < 1024 or maximum > 1048576):
                raise ValueError("Recipe script timeout or output limit is invalid.")
            if config.get("cwd") is not None and (not isinstance(config["cwd"], str)
                                                   or not config["cwd"].strip()
                                                   or any(character in config["cwd"] for character in "\r\n\0")):
                raise ValueError("Recipe script cwd is invalid.")
        if node.get("kind") == NATIVE_NODE_KIND:
            if recipe.get("systemKind") != "built-in":
                raise ValueError("Native Recipe operations are restricted to PKM built-in Recipes.")
            config = node.get("config") or {}
            operation = config.get("operation")
            arguments = config.get("arguments")
            if (not isinstance(operation, str)
                    or not re.fullmatch(r"[A-Za-z][A-Za-z0-9._-]{0,127}", operation)):
                raise ValueError("Recipe native operation identity is invalid.")
            if (not isinstance(arguments, dict)
                    or any(not isinstance(name, str)
                           or not re.fullmatch(r"[A-Za-z][A-Za-z0-9._-]{0,127}", name)
                           or not isinstance(value, str) or "\0" in value
                           for name, value in arguments.items())):
                raise ValueError("Recipe native operation arguments must be a string map.")
        if node.get("kind") == HUMAN_GATE_NODE_KIND:
            config = node.get("config") or {}
            input_kind = config.get("inputKind")
            choices = config.get("choices")
            if not isinstance(config.get("prompt"), str) or not config["prompt"].strip():
                raise ValueError("Recipe human gate prompt is required.")
            if input_kind not in {"approval", "text", "choice"}:
                raise ValueError("Recipe human gate inputKind is invalid.")
            if input_kind == "choice" and (not isinstance(choices, list) or len(choices) < 2
                                             or any(not isinstance(choice, str) or not choice.strip() for choice in choices)
                                             or len(set(choices)) != len(choices)):
                raise ValueError("Recipe human gate choices are invalid.")
            if input_kind != "choice" and choices is not None:
                raise ValueError("Recipe human gate choices are only valid for choice input.")
    nodes_by_id = {node["nodeId"]: node for node in nodes}
    for node in nodes:
        for dependency in node["dependsOn"]:
            accepted = dependency.get("accept", ["succeeded"])
            if (not isinstance(accepted, list) or not accepted
                    or any(not isinstance(outcome, str) or not outcome for outcome in accepted)):
                raise ValueError("Recipe dependency accept must be a non-empty outcome list.")
            source = nodes_by_id[dependency["from"]]
            possible = {*_accepted_outcomes(source), "skipped"}
            impossible = sorted(set(accepted) - possible)
            if impossible:
                raise ValueError(
                    f"Recipe dependency {source['nodeId']} -> {node['nodeId']} cannot emit accepted outcome(s): "
                    f"{', '.join(impossible)}. Allowed outcomes: {', '.join(sorted(possible))}."
                )
    bindings = {}
    for entry in recipe.get("nodeBindings") or []:
        node_id = entry.get("nodeId") if isinstance(entry, dict) else None
        if node_id not in node_ids or node_id in bindings or not isinstance(entry.get("bindings"), list):
            raise ValueError("Recipe knowledge bindings reference an invalid or duplicate node.")
        node_bindings = []
        binding_ids = set()
        for binding in entry["bindings"]:
            if (not isinstance(binding, dict) or not binding.get("bindingId") or binding.get("bindingId") in binding_ids
                    or binding.get("kind") not in {"skill", "note"} or not binding.get("knowledgeId")
                    or binding.get("usage") not in {"required", "recommended", "reference"}
                    or not isinstance(binding.get("contentHash"), str) or len(binding["contentHash"]) != 64):
                raise ValueError("Recipe knowledge binding is invalid or duplicated.")
            binding_ids.add(binding["bindingId"])
            node_bindings.append(binding)
        bindings[node_id] = node_bindings
    return definition, bindings

def _load_run(path):
    if not path.exists():
        raise ValueError("Recipe run was not found.")
    run = json.loads(path.read_text(encoding="utf-8"))
    if run.get("schema") != RUN_SCHEMA:
        raise ValueError("Recipe run schema is unsupported.")
    return run

def _accepted_outcomes(node):
    if node.get("kind") == HUMAN_GATE_NODE_KIND:
        config = node["config"]
        if config["inputKind"] == "approval":
            return ["approved", "rejected", "failed"]
        if config["inputKind"] == "choice":
            return [*config["choices"], "failed"]
        return ["succeeded", "failed"]
    control = node.get("control") or {"mode": "single"}
    if control.get("mode") != "branch":
        return ["succeeded", "failed"]
    return list(dict.fromkeys([*(control.get("cases") or []), "failed"]))

def _run_retry_count(run):
    return sum(max(0, int(count) - 1) for count in (run.get("nodeAttemptCounts") or {}).values())

def _run_failure_count(run):
    failed_attempts = {
        (node_id, int(record.get("attempt", 1)))
        for node_id, record in run.get("nodes", {}).items()
        if record.get("state") == "failed"
    }
    for loop in (run.get("loops") or {}).values():
        for iteration in loop.get("history") or []:
            failed_attempts.update(
                (node_id, int(record.get("attempt", iteration.get("iteration", 1))))
                for node_id, record in (iteration.get("nodes") or {}).items()
                if record.get("state") == "failed"
            )
    return len(failed_attempts)

def _recipe_usage_groups(store, recipe_id="", limit=50):
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > USAGE_SUMMARY_GROUP_LIMIT:
        raise ValueError("limit must be an integer from 1 to {}.".format(USAGE_SUMMARY_GROUP_LIMIT))
    if recipe_id and (not isinstance(recipe_id, str) or len(recipe_id) > 256):
        raise ValueError("recipe_id must be a string no longer than 256 characters.")
    directory = store / ".pkm" / "state" / "recipe-runs"
    paths = sorted(directory.glob("recipe_run_*.json"),
                   key=lambda path: path.stat().st_mtime, reverse=True)
    scanned = paths[:USAGE_SUMMARY_RUN_SCAN_LIMIT]
    groups = {}
    for path in scanned:
        try:
            run = _load_run(path)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        if recipe_id and run.get("recipeId") != recipe_id:
            continue
        key = (str(run.get("recipeId") or ""), run.get("recipeRevision"))
        group = groups.setdefault(key, {
            "recipe_id": key[0], "recipe_name": str(run.get("recipeName") or key[0])[:256],
            "revision": key[1], "run_count": 0, "measured_tokens": 0,
            "estimated_tokens": 0, "runs_with_measured_usage": 0,
            "runs_with_unknown_usage": 0, "retries": 0, "failures": 0, "failed_runs": 0,
        })
        usage = run.get("usage") or {}
        measured = usage.get("measuredTokens") or {}
        estimated = int(usage.get("estimatedTokens", 0))
        group["run_count"] += 1
        group["measured_tokens"] += int(measured.get("total_tokens", 0))
        group["estimated_tokens"] += estimated
        has_measured = int(usage.get("measuredReports", 0)) > 0
        group["runs_with_measured_usage"] += int(has_measured)
        group["runs_with_unknown_usage"] += int(
            not has_measured or int(usage.get("unknownModelCalls", 0)) > 0)
        group["retries"] += _run_retry_count(run)
        group["failures"] += _run_failure_count(run)
        group["failed_runs"] += int(run.get("status") == "failed")
    result = []
    for group in groups.values():
        runs = group["run_count"]
        group["average_measured_tokens_per_run"] = round(group.pop("measured_tokens") / runs, 2)
        group["average_estimated_tokens_per_run"] = round(group.pop("estimated_tokens") / runs, 2)
        result.append(group)
    result.sort(key=lambda item: (-item["run_count"], item["recipe_id"], str(item["revision"])))
    return result[:limit], len(paths) > len(scanned), len(scanned)

def recipe_usage_summary(recipe_id: str = "", limit: int = 50) -> str:
        """Aggregate bounded Recipe usage by Recipe identity and revision.

        Child subflows are independent runs and are counted only under their own Recipe.
        Measured provider tokens, caller estimates, and protocol payload estimates remain separate.
        """
        try:
            summaries, scan_truncated, runs_scanned = _recipe_usage_groups(store, recipe_id, limit)
            return _response(ok=True, summaries=summaries, runs_scanned=runs_scanned,
                             scan_truncated=scan_truncated,
                             accounting="one-run-per-recipe-revision; child-runs-are-not-rolled-up")
        except Exception as error:
            return _response(ok=False, error={"code": "recipe-usage-summary-failed",
                                              "message": str(error)})

def recipe_search(query: str = "", category: str = "", project_id: str = "", limit: int = 10,
                      task_contract_json: str = "{}") -> str:
        """Find Recipe candidates for a task contract; use proactively even when the user did not mention Recipes.

        Qualify candidates by purpose, inputs, outputs, constraints, and graph shape. A no-match
        response is valid and returns a design_recipe next action; never force a weak candidate.
        """
        try:
            contract = _parse_json(task_contract_json, "task_contract_json")
            return _search(store, query, category, project_id, limit, contract, subscription_cache)
        except Exception as error:
            return _response(ok=False, error={"code": "recipe-search-failed", "message": str(error)})

TOOLS = {'list_papers': {'readOnly': False}, 'list_research': {'readOnly': True}, 'get_research': {'readOnly': True}, 'get_paper': {'readOnly': True}, 'paper_graph': {'readOnly': False}, 'get_note': {'readOnly': True}, 'list_skills': {'readOnly': True}, 'get_skill': {'readOnly': True}, 'search_notes': {'readOnly': True}, 'search_skills': {'readOnly': True}, 'search_research': {'readOnly': True}, 'search_papers': {'readOnly': True}, 'list_subscriptions': {'readOnly': False}, 'search_subscribed_content': {'readOnly': False}, 'get_subscribed_content': {'readOnly': False}, 'get_subscribed_content_by_path': {'readOnly': False}, 'add_note': {'readOnly': False}, 'update_note': {'readOnly': False}, 'add_skill': {'readOnly': False}, 'update_skill': {'readOnly': False}, 'add_paper': {'readOnly': False}, 'update_paper': {'readOnly': False}, 'skill_capabilities': {'readOnly': True}, 'skill_context': {'readOnly': True}, 'delete_note': {'readOnly': False, 'trash': True}, 'delete_skill': {'readOnly': False, 'trash': True}, 'delete_paper': {'readOnly': False, 'trash': True}, 'get_knowledge': {'readOnly': True}, 'get_script': {'readOnly': True}, 'search_knowledge': {'readOnly': True}, 'search_scripts': {'readOnly': True}, 'skill_feedback': {'readOnly': False}, 'propose_skill_update': {'readOnly': False}, 'retrieval_status': {'readOnly': True}, 'retrieval_feedback': {'readOnly': False}, 'knowledge_file_trash': {'readOnly': False, 'dictionary': True, 'trash': True}, 'note_work_items': {'readOnly': True, 'native': True}, 'note_work_item_notes': {'readOnly': True, 'native': True}, 'note_work_item_command': {'readOnly': False, 'native': True}, 'note_work_item_upsert': {'readOnly': False, 'native': True}, 'todo_board_create': {'readOnly': False, 'native': True}, 'knowledge_recovery_preview': {'readOnly': True, 'dictionary': True, 'recovery': True}, 'knowledge_recovery_apply': {'readOnly': False, 'dictionary': True, 'recovery': True}, 'action_definition_check': {'readOnly': True, 'dictionary': True, 'action': True}, 'action_graph_check': {'readOnly': True, 'dictionary': True, 'action': True}, 'action_templates': {'readOnly': True, 'dictionary': True, 'action': True}, 'action_template_create': {'readOnly': False, 'dictionary': True, 'action': True}, 'action_register': {'readOnly': False, 'dictionary': True, 'action': True}, 'action_proposals': {'readOnly': True, 'dictionary': True, 'action': True}, 'action_graph_save': {'readOnly': False, 'dictionary': True, 'action': True}, 'action_get': {'readOnly': True, 'dictionary': True, 'action': True}, 'action_module_sets': {'readOnly': True, 'dictionary': True, 'action': True}, 'action_module_set_import': {'readOnly': False, 'dictionary': True, 'action': True}, 'action_module_set_load': {'readOnly': False, 'dictionary': True, 'action': True}, 'action_module_set_remove': {'readOnly': False, 'dictionary': True, 'action': True}, 'action_artifact_import': {'readOnly': False, 'dictionary': True, 'action': True}, 'action_artifact_export': {'readOnly': False, 'dictionary': True, 'action': True}, 'knowledge_snapshot_status': {'readOnly': True, 'dictionary': True, 'snapshot': True, 'annotations': {'readOnlyHint': True}}, 'knowledge_snapshot_create': {'readOnly': False, 'dictionary': True, 'snapshot': True, 'annotations': {'readOnlyHint': False}}, 'knowledge_snapshot_configure': {'readOnly': False, 'dictionary': True, 'snapshot': True, 'annotations': {'readOnlyHint': False}, 'unavailable': 'An actual separately authorized live native scheduler is not attached to this MCP host.'}, 'knowledge_snapshot_restore_preview': {'readOnly': False, 'dictionary': True, 'snapshot': True, 'annotations': {'readOnlyHint': False}}, 'knowledge_snapshot_restore_apply': {'readOnly': False, 'dictionary': True, 'snapshot': True, 'annotations': {'readOnlyHint': False, 'destructiveHint': True}}, 'asset_classify_preview': {'readOnly': True, 'dictionary': True, 'assetClassification': True, 'annotations': {'readOnlyHint': True, 'destructiveHint': False}, 'unavailable': 'Asset classification native ownership and recovery integration is not yet qualified.'}, 'asset_classify_apply': {'readOnly': False, 'dictionary': True, 'assetClassification': True, 'annotations': {'readOnlyHint': False, 'destructiveHint': False}, 'unavailable': 'Asset classification native ownership and recovery integration is not yet qualified.'}, 'asset_classify_rollback': {'readOnly': False, 'dictionary': True, 'assetClassification': True, 'annotations': {'readOnlyHint': False, 'destructiveHint': False}, 'unavailable': 'Asset classification native ownership and recovery integration is not yet qualified.'}, 'agent_session_capabilities': {'readOnly': True, 'dictionary': True}, 'agent_session_snapshot_list': {'readOnly': True, 'dictionary': True}, 'agent_session_snapshot_read': {'readOnly': True, 'dictionary': True}, 'recipe_search': {'readOnly': True, 'typed': True}, 'recipe_usage_summary': {'readOnly': True, 'typed': True}}

