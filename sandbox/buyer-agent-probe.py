#!/usr/bin/env python3
"""
D9 interop probe — external buyer agent simulation.

Exercises the GAM Seller MCP Node HTTP transport using only Python's standard
`urllib` and the `requests` library — no Node/MCP SDK, no shared code with the
server.  The goal is to break the autorreferential fixture loop: if the protocol
handshake, tool discovery, well-known trust anchor, and Default-Deny boundary all
work from a genuinely independent client, the implementation is correct at the
wire level, not just against its own fixtures.

Usage:
    python3 sandbox/buyer-agent-probe.py [base_url]
    python3 sandbox/buyer-agent-probe.py http://127.0.0.1:3900

Exit 0 on success, 1 on any assertion failure.
"""

import json
import sys
import time
from typing import Any

try:
    import requests
except ImportError:
    # Fall back to urllib (stdlib) — works on Python 3.8 without extras.
    import urllib.request as _req
    import urllib.error as _err

    class _FallbackSession:
        """Minimal requests-compatible wrapper around urllib."""

        def __init__(self):
            self.headers: dict[str, str] = {}

        def post(self, url: str, json_body: Any = None, headers: dict[str, str] | None = None) -> "_FallbackResponse":
            merged = {**self.headers, **(headers or {}), "Content-Type": "application/json"}
            data = json.dumps(json_body).encode() if json_body is not None else b""
            req = _req.Request(url, data=data, headers=merged, method="POST")
            try:
                with _req.urlopen(req) as resp:
                    return _FallbackResponse(resp.status, resp.read().decode(), dict(resp.headers))
            except _err.HTTPError as e:
                return _FallbackResponse(e.code, e.read().decode(), dict(e.headers))

        def get(self, url: str, headers: dict[str, str] | None = None) -> "_FallbackResponse":
            merged = {**self.headers, **(headers or {})}
            req = _req.Request(url, headers=merged, method="GET")
            with _req.urlopen(req) as resp:
                return _FallbackResponse(resp.status, resp.read().decode(), dict(resp.headers))

    class _FallbackResponse:
        def __init__(self, status: int, text: str, headers: dict[str, str]):
            self.status_code = status
            self.text = text
            self.headers = headers

        def json(self) -> Any:
            return json.loads(self.text)

    requests = None  # type: ignore[assignment]
    _session_cls = _FallbackSession
else:
    _session_cls = requests.Session  # type: ignore[assignment]


WELL_KNOWN_PATH = "/.well-known/seller-mcp-capabilities"
MCP_PATH = "/mcp"
MCP_ACCEPT = "application/json, text/event-stream"
MCP_CONTENT = "application/json"
UNKNOWN_BUYER = "probe-external-unknown-999"


def _parse_mcp_response(text: str) -> Any:
    """Parse MCP response — either plain JSON or the first SSE data frame."""
    stripped = text.strip()
    if stripped.startswith("data:"):
        for line in stripped.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                payload = line[len("data:"):].strip()
                if payload:
                    return json.loads(payload)
        raise ValueError(f"No data frame found in SSE response: {text!r}")
    return json.loads(stripped)


def run_probe(base_url: str) -> None:
    base_url = base_url.rstrip("/")
    session = _session_cls()
    if hasattr(session, "headers"):
        session.headers.update({"Accept": MCP_ACCEPT})

    failures: list[str] = []

    def ok(label: str) -> None:
        print(f"  OK  {label}")

    def fail(label: str, detail: str) -> None:
        msg = f"FAIL  {label}: {detail}"
        print(f"  {msg}")
        failures.append(msg)

    # ── Step 1: well-known trust anchor (public, no session) ─────────────────
    print("1. GET well-known trust anchor …")
    r = session.get(base_url + WELL_KNOWN_PATH)
    if r.status_code == 200:
        ok("status 200")
    else:
        fail("status", f"expected 200, got {r.status_code}")

    cc = r.headers.get("Cache-Control", r.headers.get("cache-control", ""))
    if "max-age=" in cc:
        ok(f"Cache-Control present ({cc!r})")
    else:
        fail("Cache-Control", f"missing max-age in {cc!r}")

    # The well-known body is a JWS compact serialisation (header.payload.sig).
    body = r.text.strip()
    parts = body.split(".")
    if len(parts) == 3:
        ok("body is JWS compact (3 dot-separated parts)")
    else:
        fail("JWS shape", f"expected 3 parts, got {len(parts)}: {body[:80]!r}")

    # ── Step 2: MCP initialize handshake ─────────────────────────────────────
    print("2. MCP initialize handshake …")
    init_req = {
        "jsonrpc": "2.0",
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "buyer-agent-probe", "version": "0.1.0"},
        },
        "id": 0,
    }
    r = session.post(
        base_url + MCP_PATH,
        json_body=init_req,
        headers={"Content-Type": MCP_CONTENT, "Accept": MCP_ACCEPT},
    )
    if r.status_code in (200, 201):
        ok(f"initialize status {r.status_code}")
    else:
        fail("initialize status", f"got {r.status_code}: {r.text[:200]!r}")
        print("\n=== PROBE ABORTED (no session) ===")
        _report(failures)
        return

    session_id = r.headers.get("Mcp-Session-Id", r.headers.get("mcp-session-id"))
    if session_id:
        ok(f"Mcp-Session-Id received ({session_id!r})")
    else:
        fail("Mcp-Session-Id", "header missing — cannot continue session")
        _report(failures)
        return

    init_body = _parse_mcp_response(r.text)
    server_name = (init_body.get("result") or {}).get("serverInfo", {}).get("name", "")
    if server_name:
        ok(f"serverInfo.name = {server_name!r}")
    else:
        fail("serverInfo.name", f"not found in {init_body}")

    session_headers = {
        "Content-Type": MCP_CONTENT,
        "Accept": MCP_ACCEPT,
        "Mcp-Session-Id": session_id,
    }

    # Send initialized notification (required by MCP spec before calling tools).
    session.post(
        base_url + MCP_PATH,
        json_body={"jsonrpc": "2.0", "method": "notifications/initialized"},
        headers=session_headers,
    )
    ok("notifications/initialized sent")

    # ── Step 3: tools/list ────────────────────────────────────────────────────
    print("3. tools/list …")
    r = session.post(
        base_url + MCP_PATH,
        json_body={"jsonrpc": "2.0", "method": "tools/list", "id": 1},
        headers=session_headers,
    )
    tools_body = _parse_mcp_response(r.text)
    tool_names = sorted(t["name"] for t in (tools_body.get("result") or {}).get("tools", []))
    expected = ["discover_products", "get_forecast", "well_known_capabilities"]
    if tool_names == expected:
        ok(f"tools = {tool_names}")
    else:
        fail("tool names", f"expected {expected}, got {tool_names}")

    # ── Step 4: well_known_capabilities tool (public surface) ─────────────────
    print("4. well_known_capabilities tool …")
    r = session.post(
        base_url + MCP_PATH,
        json_body={
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": "well_known_capabilities", "arguments": {}},
            "id": 2,
        },
        headers=session_headers,
    )
    wk_body = _parse_mcp_response(r.text)
    wk_result = (wk_body.get("result") or {})
    is_error = wk_result.get("isError", False)
    if not is_error:
        ok("well_known_capabilities: not an error")
        content = wk_result.get("content", [{}])
        doc_text = content[0].get("text", "") if content else ""
        try:
            doc = json.loads(doc_text)
            if doc.get("node_id"):
                ok(f"doc.node_id present ({doc['node_id']!r})")
            else:
                fail("doc.node_id", "missing in well_known response")
            posture = doc.get("privacy_posture", {})
            if posture.get("end_user_personal_data") == "none":
                ok("privacy_posture.end_user_personal_data = 'none' (Z3 confirmed)")
            else:
                fail("privacy_posture", f"unexpected: {posture}")
        except (json.JSONDecodeError, IndexError) as exc:
            fail("well_known doc parse", str(exc))
    else:
        fail("well_known_capabilities", f"got isError=true: {wk_result}")

    # ── Step 5: Default-Deny boundary — unknown buyer → AUTH_FAILED ───────────
    print("5. Default-Deny: unknown buyer → AUTH_FAILED …")
    r = session.post(
        base_url + MCP_PATH,
        json_body={
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": "discover_products", "arguments": {"buyer_id": UNKNOWN_BUYER}},
            "id": 3,
        },
        headers=session_headers,
    )
    deny_body = _parse_mcp_response(r.text)
    deny_result = (deny_body.get("result") or {})
    deny_is_error = deny_result.get("isError", False)
    if deny_is_error:
        deny_content = deny_result.get("content", [{}])
        deny_text = deny_content[0].get("text", "") if deny_content else ""
        try:
            deny_doc = json.loads(deny_text)
            code = deny_doc.get("code", "")
            if code == "AUTH_FAILED":
                ok(f"AUTH_FAILED received for unknown buyer (Default-Deny ✓)")
            else:
                fail("error code", f"expected AUTH_FAILED, got {code!r}")
        except json.JSONDecodeError:
            fail("deny response parse", deny_text[:100])
    else:
        fail("Default-Deny", "expected isError=true for unknown buyer, got success")

    _report(failures)


def _report(failures: list[str]) -> None:
    print()
    if failures:
        print(f"=== PROBE FAILED: {len(failures)} assertion(s) ===")
        for f in failures:
            print(f"  · {f}")
        sys.exit(1)
    else:
        print("=== PROBE PASSED: all assertions green ===")


if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3900"
    print(f"GAM Seller MCP Node — buyer agent probe")
    print(f"Target: {base}")
    print()
    run_probe(base)
