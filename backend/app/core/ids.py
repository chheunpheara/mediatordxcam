"""Opaque identifier generation.

All handles the API hands out are opaque and prefixed so they are self-describing
in a log line without ever revealing a filesystem path or an upstream identifier
(§29). Prefix + uuid4 hex is 4 + 32 characters — short enough to read in a UI
debug panel, unguessable enough that artefact handles cannot be probed.

Nothing in this module derives an identifier from user data.
"""

from __future__ import annotations

import uuid

#: Header used to accept and echo a correlation id.
REQUEST_ID_HEADER = "X-Request-Id"

_PREFIXES = {
    "request": "req",
    "artifact": "art",
    "processing": "proc",
    "verification": "ver",
    "liveness": "liv",
}


def _new(kind: str) -> str:
    """Generate `<prefix>_<uuid4hex>` for a named id kind."""
    return f"{_PREFIXES[kind]}_{uuid.uuid4().hex}"


def new_request_id() -> str:
    """Correlation id for one HTTP request."""
    return _new("request")


def new_artifact_handle() -> str:
    """Opaque handle for a stored biometric artefact.

    The handle is the only thing the client ever learns about a stored file. The
    filesystem path is never exposed, so path traversal is not expressible (§29).
    """
    return _new("artifact")


def new_processing_id() -> str:
    """Identifier for one ID-card / passport processing run."""
    return _new("processing")


def new_verification_id() -> str:
    """Identifier for one verification attempt."""
    return _new("verification")


def new_liveness_session_id() -> str:
    """Identifier for one liveness session (§18)."""
    return _new("liveness")


def is_artifact_handle(value: str) -> bool:
    """True when `value` has the shape of an artefact handle.

    Used to reject a malformed handle before it reaches storage, so the store
    never receives caller-controlled path fragments.
    """
    prefix = f"{_PREFIXES['artifact']}_"
    return (
        value.startswith(prefix)
        and len(value) == len(prefix) + 32
        and all(char in "0123456789abcdef" for char in value[len(prefix) :])
    )
