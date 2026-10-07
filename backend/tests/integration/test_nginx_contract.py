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

import re

import yaml

from app.core.config import BACKEND_ROOT

REPO_ROOT = BACKEND_ROOT.parent
NGINX_CONF = REPO_ROOT / "frontend" / "nginx.conf"
COMPOSE_FILE = REPO_ROOT / "docker-compose.yml"

_SIZE_MULTIPLIERS = {None: 1, "k": 1024, "m": 1024**2, "g": 1024**3}


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


def test_nginx_accepts_every_upload_the_api_accepts() -> None:
    """nginx must not be the body-size limit for biometric uploads (§14).

    The API caps a body at `MAX_UPLOAD_BYTES` and answers over the cap with a
    JSON envelope. nginx's own default (1 MB) sits below that and answers with
    an HTML 413 page, which the browser cannot parse — the customer display
    reports a string-parsing error instead of a refused upload, and the teller
    sees `SyntaxError: The string did not match the expected pattern.`
    """
    conf = NGINX_CONF.read_text()
    match = re.search(r"client_max_body_size\s+(\d+)([kmg])?;", conf)
    assert match is not None, "nginx must bound request bodies explicitly"
    nginx_limit = int(match.group(1)) * _SIZE_MULTIPLIERS[match.group(2)]

    compose = yaml.safe_load(COMPOSE_FILE.read_text())
    raw = str(compose["services"]["app"]["environment"]["MAX_UPLOAD_BYTES"])
    api_limit = int(raw.rsplit(":-", 1)[1].rstrip("}"))

    assert nginx_limit > api_limit, (
        f"nginx allows {nginx_limit} bytes but the API only {api_limit}: an oversized body "
        "would be rejected by nginx as HTML rather than by the API as JSON"
    )
