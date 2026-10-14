"""play / heartbeat carry the host's clock stamp and output latency to guests.

Guests use them to line up with the host (screen.js _hostTimeNow); the
server passes them through as finite numbers, else null.
"""


def _create_room(client, name="Alice"):
    r = client.post("/api/plugins/multiplayer/rooms", json={"name": name})
    assert r.status_code == 200
    body = r.json()
    return body["code"], body["player_id"]


def _join_room(client, code, name="Bob"):
    r = client.post(f"/api/plugins/multiplayer/rooms/{code}/join", json={"name": name})
    assert r.status_code == 200
    return r.json()["player_id"]


def _ws_url(code, player_id, session_id):
    return f"/ws/plugins/multiplayer/{code}?player_id={player_id}&session_id={session_id}"


def _recv_type(ws, msg_type, limit=20):
    for _ in range(limit):
        msg = ws.receive_json()
        if msg.get("type") == msg_type:
            return msg
    raise AssertionError(f"no {msg_type!r} message")


def test_play_and_heartbeat_pass_clock_stamp_and_ahead_through(client):
    code, alice = _create_room(client)
    bob = _join_room(client, code)

    with client.websocket_connect(_ws_url(code, alice, "sid-alice")) as ws_a, \
            client.websocket_connect(_ws_url(code, bob, "sid-bob")) as ws_b:
        _recv_type(ws_a, "connected")
        _recv_type(ws_b, "connected")

        ws_a.send_json({"type": "play", "time": 12.5, "speed": 1.0,
                        "host_server_t": 123456.75, "ahead_ms": 42.5})
        msg = _recv_type(ws_b, "playback_state")
        assert msg["state"] == "playing"
        assert msg["host_server_t"] == 123456.75
        assert msg["ahead_ms"] == 42.5
        assert isinstance(msg["server_time"], float)

        ws_a.send_json({"type": "heartbeat", "time": 13.0,
                        "host_server_t": 123956, "ahead_ms": 40})
        msg = _recv_type(ws_b, "heartbeat")
        assert msg["time"] == 13.0
        assert msg["host_server_t"] == 123956
        assert msg["ahead_ms"] == 40


def test_bad_or_missing_sync_fields_become_null(client):
    code, alice = _create_room(client)
    bob = _join_room(client, code)

    with client.websocket_connect(_ws_url(code, alice, "sid-alice")) as ws_a, \
            client.websocket_connect(_ws_url(code, bob, "sid-bob")) as ws_b:
        _recv_type(ws_a, "connected")
        _recv_type(ws_b, "connected")

        # Older hosts send neither field.
        ws_a.send_json({"type": "heartbeat", "time": 1.0})
        msg = _recv_type(ws_b, "heartbeat")
        assert msg["host_server_t"] is None and msg["ahead_ms"] is None

        for bad in ("nan", "inf", "abc", True, [1], {"x": 1}):
            ws_a.send_json({"type": "heartbeat", "time": 1.0,
                            "host_server_t": bad, "ahead_ms": bad})
            msg = _recv_type(ws_b, "heartbeat")
            assert msg["host_server_t"] is None, bad
            assert msg["ahead_ms"] is None, bad


def test_num_or_none(routes_module):
    f = routes_module._num_or_none
    assert f(3) == 3.0
    assert f("2.5") == 2.5
    assert f(None) is None
    assert f(float("nan")) is None
    assert f(float("-inf")) is None
    assert f(False) is None
