"""The frontend nginx config is part of the product surface (§30).

`frontend/nginx.conf` is the server the browser actually talks to, and its
failures are invisible to the backend's own tests because the SPA fallback
answers a missing location with `index.html` and a 200. Two such failures have
the same shape: a path that is not proxied reaches the shell instead of the API,
and a WebSocket handshake that is not upgraded receives HTML, so the socket
never opens. That one surfaces in the product as the teller screen stuck on
"Waiting for the customer's webcam frames…".

These assert the proxy contract directly, since no in-process test can cross
the nginx boundary.
"""

from __future__ import annotations

from app.core.config import BACKEND_ROOT

REPO_ROOT = BACKEND_ROOT.parent
NGINX_CONF = REPO_ROOT / "frontend" / "nginx.conf"


def _location(path: str) -> str:
    """The body of `location <path> { … }` in the nginx config."""
    conf = NGINX_CONF.read_text()
    start = conf.index(f"location {path} {{")
    end = conf.index("\n    }\n", start)
    return conf[start:end]


def test_the_websocket_relay_is_upgraded_not_answered_by_the_spa_shell() -> None:
    """`/ws/` needs its own upgrade-aware location.

    nginx picks the longest matching prefix, so `location /ws/` wins over the
    `location /` SPA fallback — but only when it exists. Without it the
    handshake receives `index.html`, and the browser reports a socket that
    never opened.
    """
    conf = NGINX_CONF.read_text()
    relay = _location("/ws/")

    assert "map $http_upgrade $connection_upgrade" in conf
    assert "proxy_pass http://backend;" in relay
    assert "proxy_http_version 1.1;" in relay
    assert "proxy_set_header Upgrade $http_upgrade;" in relay
    assert "proxy_set_header Connection $connection_upgrade;" in relay


def test_the_relay_is_not_cut_off_mid_verification() -> None:
    """A verification runs for minutes; nginx's default 60s timeout does not.

    Frames must also stream rather than sit in nginx's buffer until a flush.
    """
    relay = _location("/ws/")

    assert "proxy_read_timeout 1h;" in relay
    assert "proxy_send_timeout 1h;" in relay
    assert "proxy_buffering off;" in relay
