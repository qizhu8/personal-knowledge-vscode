"""
Pluggable LLM client for the PKM session agents.

One tiny interface — `AiClient.complete(system, user) -> str` — behind several
backends so the same agent code runs against any of them:

  * mock    : deterministic, offline. Proves the wiring without a real model.
  * openai  : any OpenAI-compatible /chat/completions endpoint.
  * vllm    : alias of `openai` (vLLM serves the OpenAI-compatible API).
  * pyparus : placeholder for the multi-model Pyparus API — fill in the request
              shape once the endpoint/contract is known (see _pyparus below).
  * human   : defers to a human. Standalone it just raises; the agent supplies a
              callback (post the prompt to the room, wait for a human reply).

Config via env (overridable per call site):
  PKM_LLM_BACKEND   mock | openai | vllm | pyparus | human
  PKM_LLM_BASE_URL  e.g. http://localhost:8000/v1   (openai/vllm)
  PKM_LLM_MODEL     e.g. qwen2.5-7b-instruct
  PKM_LLM_API_KEY   bearer token (optional for local vLLM)
  PKM_LLM_TEMP      sampling temperature (default 0.2)

Never hard-code secrets; read keys from the environment / SecretStorage.
"""
from __future__ import annotations

import os
import json
from typing import Callable, Optional

try:
    import requests
except ImportError:  # requests is optional for the mock/human backends
    requests = None


class AiClient:
    def __init__(self, backend: str = "mock", base_url: Optional[str] = None,
                 model: Optional[str] = None, api_key: Optional[str] = None,
                 temperature: float = 0.2, timeout: int = 60,
                 human_fn: Optional[Callable[[str, str], str]] = None):
        self.backend = (backend or "mock").lower()
        self.base_url = (base_url or "").rstrip("/")
        self.model = model or ""
        self.api_key = api_key or ""
        self.temperature = float(temperature)
        self.timeout = int(timeout)
        self.human_fn = human_fn

    @classmethod
    def from_env(cls, **overrides):
        cfg = dict(
            backend=os.environ.get("PKM_LLM_BACKEND", "mock"),
            base_url=os.environ.get("PKM_LLM_BASE_URL", ""),
            model=os.environ.get("PKM_LLM_MODEL", ""),
            api_key=os.environ.get("PKM_LLM_API_KEY", ""),
            temperature=float(os.environ.get("PKM_LLM_TEMP", "0.2")),
        )
        cfg.update({k: v for k, v in overrides.items() if v is not None})
        return cls(**cfg)

    # ── public API ───────────────────────────────────────────────────────────
    def complete(self, system: str, user: str) -> str:
        fn = getattr(self, f"_{self.backend}", None)
        if fn is None:
            raise ValueError(f"unknown LLM backend: {self.backend!r}")
        return fn(system, user)

    def describe(self) -> str:
        who = self.backend
        if self.backend in ("openai", "vllm"):
            who += f" {self.model or '?'} @ {self.base_url or '?'}"
        elif self.backend == "pyparus":
            who += f" {self.model or '?'}"
        return who

    # ── backends ─────────────────────────────────────────────────────────────
    def _mock(self, system: str, user: str) -> str:
        head = user.strip().splitlines()[0] if user.strip() else "(empty)"
        return f"[mock] handled task: {head[:120]} — 3 findings, no blockers."

    def _openai(self, system: str, user: str) -> str:
        if requests is None:
            raise RuntimeError("requests not installed (pip install requests)")
        if not self.base_url:
            raise RuntimeError("PKM_LLM_BASE_URL is required for the openai/vllm backend")
        url = f"{self.base_url}/chat/completions"
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        body = {
            "model": self.model,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
            "temperature": self.temperature,
        }
        r = requests.post(url, headers=headers, data=json.dumps(body), timeout=self.timeout)
        r.raise_for_status()
        data = r.json()
        return data["choices"][0]["message"]["content"]

    # vLLM exposes the OpenAI-compatible API.
    _vllm = _openai

    def _pyparus(self, system: str, user: str) -> str:
        # TODO: implement once the Pyparus request/response contract is known.
        # Expected shape (fill in): POST {base_url} with model + prompt, read the
        # completion text back. Kept explicit so it fails loudly until wired.
        raise NotImplementedError(
            "pyparus backend not wired yet — provide the endpoint URL, auth, and "
            "request/response JSON shape and I'll implement _pyparus().")

    def _human(self, system: str, user: str) -> str:
        if self.human_fn is None:
            raise NotImplementedError(
                "human backend needs a callback (the agent posts the prompt to the "
                "room and waits for a human reply).")
        return self.human_fn(system, user)
