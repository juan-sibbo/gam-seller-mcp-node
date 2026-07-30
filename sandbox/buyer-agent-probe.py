#!/usr/bin/env python3
"""
D9 interop probe — external buyer agent simulation.

Exercises the GAM Seller MCP Node HTTP transport using only Python's `requests`
library (or stdlib urllib fallback) — no Node/MCP SDK, no shared code with the
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
from typing import Any

try:
    import requests as _requests
    _HAS_REQUESTS = True
except ImportError:
    _HAS_REQUESTS = False
    import urllib.request as _urllib_req
    import urllib.error as _urllib_err


WELL_KNOWN_PATH = "/.well-known/seller-mcp-capabilities"
MCP_PATH = "/mcp"
MCP_ACCEPT = "application/json, text/event-stream"
MCP_CONTENT = "application/json"
UNKNOWN_BUYER = "probe-external-unknown-999"


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _http_get(url: str, extra_headers: dict | None = None) -> tuple[int, str, dict]:
    """Return (status, body_text, headers)."""
    hdrs = {**(extra_headers or {})}
    if _HAS_REQUESTS:
        r = _requests.get(url, headers=hdrs, timeout=10)
        return r.status_code, r.text, dict(r.headers)
    req = _urllib_req.Request(url, headers=hdrs, method="GET")
    try:
        with _urllib_req.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read().decode(), dict(resp.headers)
    except _urllib_err.HTTPError as e:
        return e.code, e.read().decode(), dict(e.headers)


def _mcp_post(url: str, body: Any, session_id: str | None = None) -> tuple[int, Any, dict]:
    """POST to the MCP endpoint; read SSE stream when Content-Type is text/event-stream.

    Returns (status_code, parsed_body_or_None, response_headers).
    Notifications (no 'id' in body) return (status, None, headers).
    """
    headers = {
        "Content-Type": MCP_CONTENT,
        "Accept": MCP_ACCEPT,
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id

    raw = json.dumps(body).encode()

    if _HAS_REQUESTS:
        r = _requests.post(url, data=raw, headers=headers, stream=True, timeout=10)
        resp_headers = dict(r.headers)
        ct = resp_headers.get("Content-Type", resp_headers.get("content-type", ""))

        if "text/event-stream" in ct:
            # Read lines until we get the first data frame carrying a JSON-RPC result.
            for line in r.iter_lines(decode_unicode=True):
                if line and line.startswith("data:"):
                    payload = line[5:].strip()
                    if payload:
                        return r.status_code, json.loads(payload), resp_headers
            # SSE stream ended without a data frame (e.g. notification 202).
            return r.status_code, None, resp_headers
        else:
            text = r.text.strip()
            return r.status_code, (json.loads(text) if text else None), resp_headers

    # --- urllib fallback (Python 3.8, no requests) ---
    req = _urllib_req.Request(url, data=raw, headers=headers, method="POST")
    try:
        with _urllib_req.urlopen(req, timeout=10) as resp:
            body_bytes = resp.read()
            resp_headers = dict(resp.headers)
            ct = resp_headers.get("Content-Type", resp_headers.get("content-type", ""))
            text = body_bytes.decode().strip()
            if not text:
                return resp.status, None, resp_headers
            if "text/event-stream" in ct:
                for line in text.splitlines():
                    if line.startswith("data:"):
                        payload = line[5:].strip()
                        if payload:
                            return resp.status, json.loads(payload), resp_headers
                return resp.status, None, resp_headers
            return resp.status, json.loads(text), resp_headers
    except _urllib_err.HTTPError as e:
        return e.code, None, dict(e.headers)


# ── Probe ─────────────────────────────────────────────────────────────────────

def run_probe(base_url: str) -> None:
    base_url = base_url.rstrip("/")
    failures: list[str] = []

    def ok(label: str) -> None:
        print(f"  OK  {label}")

    def fail(label: str, detail: str) -> None:
        print(f"  FAIL  {label}: {detail}")
        failures.append(f"{label}: {detail}")

    # ── 1: well-known trust anchor (public GET) ───────────────────────────────
    print("1. GET well-known trust anchor …")
    status, body_text, resp_headers = _http_get(base_url + WELL_KNOWN_PATH)

    if status == 200:
        ok("status 200")
    else:
        fail("status", f"expected 200, got {status}")

    cc = resp_headers.get("Cache-Control", resp_headers.get("cache-control", ""))
    if "max-age=" in cc:
        ok(f"Cache-Control present ({cc!r})")
    else:
        fail("Cache-Control", f"missing max-age in {cc!r}")

    parts = body_text.strip().split(".")
    if len(parts) == 3:
        ok("body is JWS compact (3 dot-separated parts)")
    else:
        fail("JWS shape", f"expected 3 parts, got {len(parts)}: {body_text[:80]!r}")

    # ── 2: MCP initialize ─────────────────────────────────────────────────────
    print("2. MCP initialize handshake …")
    status, parsed, resp_headers = _mcp_post(
        base_url + MCP_PATH,
        {
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "buyer-agent-probe", "version": "0.1.0"},
            },
            "id": 0,
        },
    )

    if status in (200, 201):
        ok(f"initialize status {status}")
    else:
        fail("initialize status", f"got {status}")
        _report(failures)
        return

    session_id = resp_headers.get("Mcp-Session-Id", resp_headers.get("mcp-session-id"))
    if session_id:
        ok(f"Mcp-Session-Id received ({session_id!r})")
    else:
        fail("Mcp-Session-Id", "header missing — cannot continue session")
        _report(failures)
        return

    if parsed:
        server_name = (parsed.get("result") or {}).get("serverInfo", {}).get("name", "")
        if server_name:
            ok(f"serverInfo.name = {server_name!r}")
        else:
            fail("serverInfo.name", f"not found in {parsed}")
    else:
        fail("initialize body", "empty response body")
        _report(failures)
        return

    # Send initialized notification (no response expected).
    _mcp_post(
        base_url + MCP_PATH,
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        session_id=session_id,
    )
    ok("notifications/initialized sent")

    # ── 3: tools/list ─────────────────────────────────────────────────────────
    print("3. tools/list …")
    _, tools_parsed, _ = _mcp_post(
        base_url + MCP_PATH,
        {"jsonrpc": "2.0", "method": "tools/list", "id": 1},
        session_id=session_id,
    )
    if tools_parsed:
        tool_names = sorted(t["name"] for t in (tools_parsed.get("result") or {}).get("tools", []))
        expected = ["create_intent", "discover_products", "get_forecast", "revoke_intent", "well_known_capabilities"]
        if tool_names == expected:
            ok(f"tools = {tool_names}")
        else:
            fail("tool names", f"expected {expected}, got {tool_names}")
    else:
        fail("tools/list", "empty response")

    # ── 4: well_known_capabilities (public surface) ───────────────────────────
    print("4. well_known_capabilities tool …")
    _, wk_parsed, _ = _mcp_post(
        base_url + MCP_PATH,
        {
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": "well_known_capabilities", "arguments": {}},
            "id": 2,
        },
        session_id=session_id,
    )
    if not wk_parsed:
        fail("well_known_capabilities", "empty response")
    else:
        wk_result = wk_parsed.get("result") or {}
        if wk_result.get("isError"):
            fail("well_known_capabilities", f"isError=true: {wk_result}")
        else:
            ok("well_known_capabilities: not an error")
            content = wk_result.get("content", [{}])
            doc_text = content[0].get("text", "") if content else ""
            # The tool returns a JWS compact form (eyJ…) — decode the payload segment.
            jws_parts = doc_text.strip().split(".")
            if len(jws_parts) == 3:
                import base64
                # base64url padding
                seg = jws_parts[1] + "=" * (-len(jws_parts[1]) % 4)
                try:
                    doc = json.loads(base64.urlsafe_b64decode(seg).decode())
                    if doc.get("node_id"):
                        ok(f"doc.node_id present ({doc['node_id']!r})")
                    else:
                        fail("doc.node_id", "missing")
                    cap_families = doc.get("capability_families", [])
                    if cap_families:
                        ok(f"capability_families = {cap_families!r}")
                    else:
                        fail("capability_families", "empty or missing")
                    posture = doc.get("privacy_posture", {})
                    if posture.get("end_user_personal_data") == "none":
                        ok("privacy_posture.end_user_personal_data = 'none' (Z3 ✓)")
                    else:
                        fail("privacy_posture", f"unexpected: {posture}")
                except Exception as e:
                    fail("JWS payload decode", str(e))
            else:
                fail("JWS shape", f"expected 3 parts, got {len(jws_parts)}: {doc_text[:60]!r}")

    # ── 5: Default-Deny — no buyer token → AUTH_FAILED ────────────────────────
    # v0.4 Bloque A: identity is derived from a buyer token's sub (no buyer_id argument).
    # A call with no token has no derivable identity → Default-Deny.
    print("5. Default-Deny: no buyer token → AUTH_FAILED …")
    _, deny_parsed, _ = _mcp_post(
        base_url + MCP_PATH,
        {
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": "discover_products", "arguments": {}},
            "id": 3,
        },
        session_id=session_id,
    )
    if not deny_parsed:
        fail("Default-Deny", "empty response")
    else:
        deny_result = deny_parsed.get("result") or {}
        if deny_result.get("isError"):
            deny_content = deny_result.get("content", [{}])
            deny_text = deny_content[0].get("text", "") if deny_content else ""
            try:
                deny_doc = json.loads(deny_text)
                code = deny_doc.get("code", "")
                if code == "AUTH_FAILED":
                    ok("AUTH_FAILED received for a call with no token (Default-Deny ✓)")
                else:
                    fail("error code", f"expected AUTH_FAILED, got {code!r}")
            except json.JSONDecodeError:
                fail("deny response parse", deny_text[:100])
        else:
            fail("Default-Deny", "expected isError=true for a call with no token, got success")

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
    print("GAM Seller MCP Node — buyer agent probe")
    print(f"Target: {base}")
    print()
    run_probe(base)
