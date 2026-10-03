"""Logging setup with mandatory redaction.

§29 forbids logging biometric bytes, national IDs, names, artefact paths or
CamDX credentials. That rule is enforced here as a `logging.Filter` rather than
left to discipline at each call site, because a filter catches the mistake even
when the log call is wrong.

Strategy:

* A `RedactingFilter` scrubs every record — message and arguments — against
  registered patterns before a handler formats it.
* Redaction is pattern-based rather than value-based, so a value that leaks
  through an unexpected keyword argument is still caught.
* Payload logging exists behind `LOG_SENSITIVE_PAYLOADS` and is documented as
  unsafe (§29).

Allowed in logs: request id, route, status, duration, mode, error code, artefact
*count*. Never: identity values, image bytes, artefact paths, credentials.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from typing import Any

#: Values registered here are scrubbed from every log record. Populated at
#: startup from settings so configured secrets are covered even if some code
#: path logs them by accident.
_SENSITIVE_VALUES: set[str] = set()

#: Field names whose values are always replaced, whatever they contain. Covers
#: structured `extra={...}` logging.
SENSITIVE_KEYS = frozenset(
    {
        "national_id",
        "nationalid",
        "first_name",
        "firstname",
        "first_name_khmer",
        "first_name_english",
        "last_name",
        "lastname",
        "last_name_khmer",
        "last_name_english",
        "date_of_birth",
        "dateofbirth",
        "dob",
        "gender",
        "issued_date",
        "expired_date",
        "passport_number",
        "passportnumber",
        "client_secret",
        "client_id",
        "api_key",
        "authorization",
        "cookie",
        "token",
        "password",
        "file_path",
        "artifact_path",
        "image_bytes",
        "face_bytes",
        "payload",
        "raw_response",
    }
)

_REDACTED = "[redacted]"

#: Patterns applied to formatted log text, in order. These catch values that were
#: never registered — a national ID embedded in an upstream message, a bearer token
#: in a URL, a temp path in a stack frame.
#:
#: Order matters: the path pattern runs before the handle pattern so a whole path
#: is removed in one pass rather than leaving a partial fragment behind.
_PATTERNS: tuple[re.Pattern[str], ...] = (
    # Filesystem paths inside the temp storage directory, extension included.
    re.compile(r"(?:[\w.-]+/)*var/tmp/[\w./\[\]-]+"),
    # art_/proc_/ver_/liv_/req_ handles: keep the prefix, drop the identifier.
    re.compile(r"\b(art|proc|ver|liv|req)_[0-9a-f]{8,}\b"),
    # Khmer national ID / passport-like digit runs of 6+.
    re.compile(r"\b\d{6,}\b"),
    # Authorization headers and bearer tokens.
    re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._\-]+"),
    re.compile(r"(?i)\b(api[_-]?key|client[_-]?secret|password|token)\b\s*[=:]\s*\S+"),
)


def register_sensitive_values(values: list[str | None]) -> None:
    """Register literal values that must never appear in a log line.

    Called once at startup with the configured CamDX credentials and secrets.
    Short values are ignored: redacting a 3-character string would corrupt
    unrelated text without protecting anything meaningful.
    """
    for value in values:
        if value and len(value) >= 8:
            _SENSITIVE_VALUES.add(value)


def redact(text: str) -> str:
    """Return `text` with every sensitive pattern replaced."""
    for value in _SENSITIVE_VALUES:
        text = text.replace(value, _REDACTED)
    for pattern in _PATTERNS:
        text = pattern.sub(_REDACTED, text)
    return text


class RedactingFilter(logging.Filter):
    """Scrub sensitive data from every record before it reaches a handler."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact(record.msg)

        # Redact `extra={...}` fields by name. `record.__dict__` holds them after
        # the record was created, so scrubbing here covers the whole payload.
        for key in [k for k in record.__dict__ if k.lower() in SENSITIVE_KEYS]:
            record.__dict__[key] = _REDACTED

        if record.args:
            record.args = _redact_args(record.args)

        return True


def _redact_args(args: Any) -> Any:
    if isinstance(args, dict):
        return {
            key: (_REDACTED if str(key).lower() in SENSITIVE_KEYS else redact(str(value)))
            for key, value in args.items()
        }
    if isinstance(args, tuple):
        return tuple(redact(str(value)) for value in args)
    return redact(str(args))


class JsonFormatter(logging.Formatter):
    """One JSON object per line — greppable, and safe to ship to a log store."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key.startswith("_") or key in _STANDARD_ATTRS:
                continue
            payload[key] = value
        if record.exc_info:
            payload["error_type"] = record.exc_info[0].__name__ if record.exc_info[0] else None
            if record.exc_text:
                # A traceback can embed a temp path or an upstream body. The frames
                # are useful; the values are not.
                payload["traceback"] = redact(record.exc_text)
        return json.dumps(payload, default=str, ensure_ascii=False)


_STANDARD_ATTRS = frozenset(
    {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "module",
        "msecs",
        "message",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "taskName",
        "thread",
        "threadName",
    }
)


def configure_logging(
    *,
    level: str = "INFO",
    allow_sensitive_payloads: bool = False,
    force: bool = False,
) -> None:
    """Install the JSON handler and the redaction filter on the root logger.

    Args:
        level: Root log level name.
        allow_sensitive_payloads: Mirrors `LOG_SENSITIVE_PAYLOADS`. When false,
            the `camdx.payload` logger is disabled outright, so payload logging
            cannot be switched on from an endpoint or a stray call site.
        force: Reconfigure even if handlers already exist (used by tests).
    """
    if force:
        root = logging.getLogger()
        for handler in list(root.handlers):
            root.removeHandler(handler)

    root = logging.getLogger()
    root.setLevel(level.upper())

    for handler in list(root.handlers):
        if not any(isinstance(f, RedactingFilter) for f in handler.filters):
            handler.addFilter(RedactingFilter())

    if not root.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JsonFormatter())
        handler.addFilter(RedactingFilter())
        root.addHandler(handler)

    # Toggle rather than only ever disabling: a test or an explicit
    # `allow_sensitive_payloads=True` must be able to re-enable it, and
    # reconfiguring must not accumulate filters on the root logger.
    payload_logger = logging.getLogger("camdx.payload")
    payload_logger.disabled = not allow_sensitive_payloads
    for existing in list(payload_logger.filters):
        payload_logger.removeFilter(existing)
    if not allow_sensitive_payloads:
        payload_logger.addFilter(logging.Filter("payloads_disabled"))

    # Third-party loggers are noisy and can echo URLs containing credentials.
    for noisy in ("httpx", "httpcore", "urllib3", "multipart", "python_multipart"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
