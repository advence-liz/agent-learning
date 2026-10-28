from mcp_protocol.raw_client import edge_cases, session


def test_full_session_messages():
    c = session(verbose=False)
    c.close()
    sent = [m for d, m in c.log if d == "→"]
    got = {m["id"]: m for d, m in c.log if d == "←"}
    assert [m["method"] for m in sent] == [
        "initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call",
        "resources/subscribe_everything", "ping"]
    assert "id" not in sent[1]  # 通知没有 id
    assert len(got) == 6  # 7 条发出，通知那条没有回应

    init = got[1]["result"]
    assert init["protocolVersion"] == "2025-11-25" and init["serverInfo"]["name"] == "notes"
    tools = {t["name"]: t for t in got[2]["result"]["tools"]}
    assert tools["search_notes"]["inputSchema"]["required"] == ["query"]
    assert got[3]["result"]["isError"] is False
    assert got[3]["result"]["structuredContent"]["result"][0]["path"] == "claude-hooks.md"
    assert got[4]["result"]["isError"] is True and "error" not in got[4]
    assert got[5]["error"]["code"] == -32601
    assert got[6]["result"] == {}


def test_edge_cases():
    out = edge_cases(verbose=False)
    assert "error" in out["no_handshake"]
    assert out["bad_version"]["result"]["protocolVersion"] == "2025-11-25"
