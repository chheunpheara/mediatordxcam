"""Opaque temporary artefact storage (§29).

Sensitive files land here, never in a static mount and never in Git. Two
properties matter more than speed:

* **Nothing addressable by the caller.** A stored artefact is only ever named by
  an opaque handle (§"ids"); the filesystem path is never derived from user input,
  so path traversal is not expressible rather than merely validated against.
* **Automatic expiry.** Biometric data must not outlive its usefulness, so every
  artefact carries an expiry and a sweeper removes it. A handle that is stale
  reports `expired` rather than `not found` so the client can say the right
  thing (§28).

Files are written with mode `0600` inside a `0700` directory.
"""

from __future__ import annotations

import logging
import os
import shutil
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from app.core.errors import ArtifactNotFoundError
from app.core.ids import is_artifact_handle, new_artifact_handle
from app.services.uploads import SERVABLE_MEDIA_TYPES, sniff_media_type

logger = logging.getLogger("camdx.artefacts")

#: Prefix for every stored artefact, so cleanup cannot wander into other files.
ARTEFACT_PREFIX = "artefact_"

#: Fallback for content we do not recognise. Not a servable format, so the
#: artefact endpoint will refuse to serve it even though the bytes are intact.
UNKNOWN_MEDIA_TYPE = "application/octet-stream"

#: Enough leading bytes for every accepted format's signature, including WebP,
#: whose `WEBP` form type sits 8 bytes in behind the RIFF chunk size.
_SIGNATURE_PROBE_BYTES = 16


@dataclass(frozen=True, slots=True)
class StoredArtefact:
    """A stored file and the handle that names it.

    `path` is deliberately not part of the API response model. It exists for the
    services that need to read the bytes back; it never crosses the HTTP boundary.
    """

    handle: str
    path: Path
    media_type: str
    size_bytes: int
    expires_at: float

    @property
    def is_expired(self) -> bool:
        """True once the TTL has passed."""
        import time

        return time.time() >= self.expires_at


class TempArtifactStore:
    """Short-lived storage for uploaded documents and extracted faces.

    Not a cache: an artefact is expected to be read once by the service that
    produced it and then expire. There is deliberately no `list`, no size report
    and no way to enumerate what is stored, because nothing in the application
    needs those and each would widen the blast radius of a mistake.
    """

    def __init__(self, root: Path, *, ttl_seconds: int) -> None:
        self._root = Path(root)
        self._ttl_seconds = ttl_seconds
        # Create eagerly with tight permissions: the directory holds ID cards.
        self._root.mkdir(parents=True, exist_ok=True)
        try:
            self._root.chmod(0o700)
        except OSError:  # pragma: no cover - non-POSIX filesystem
            logger.warning("could not tighten permissions on temp storage")

    @property
    def root(self) -> Path:
        """Storage root. Exposed for diagnostics and tests, never for responses."""
        return self._root

    def put(self, data: bytes, *, media_type: str = "application/octet-stream") -> StoredArtefact:
        """Store `data` and return its handle.

        The handle is generated here and the filename is derived from it, so a
        caller can never influence the path.
        """
        import time

        handle = new_artifact_handle()
        path = self._path_for(handle)
        # Exclusive create: refuse to overwrite, so two handles can never collide.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as handle_obj:
                handle_obj.write(data)
        except BaseException:
            # A partial file must not survive a failed write; it would otherwise
            # be served as if it were complete.
            path.unlink(missing_ok=True)
            raise

        artefact = StoredArtefact(
            handle=handle,
            path=path,
            media_type=media_type,
            size_bytes=len(data),
            expires_at=time.time() + self._ttl_seconds,
        )
        logger.info(
            "artefact stored",
            extra={"handle": handle, "media_type": media_type, "size_bytes": len(data)},
        )
        return artefact

    def get(self, handle: str) -> StoredArtefact:
        """Return the artefact for `handle`.

        Raises:
            ArtifactNotFoundError: if the handle is malformed, unknown, or expired.
        """
        if not is_artifact_handle(handle):
            # Do not distinguish "malformed" from "absent" in the message: the
            # distinction is only useful to someone probing for handles.
            raise ArtifactNotFoundError()

        path = self._path_for(handle)
        try:
            stat = path.stat()
        except FileNotFoundError:
            raise ArtifactNotFoundError() from None

        artefact = StoredArtefact(
            handle=handle,
            path=path,
            media_type=detect_media_type(path),
            size_bytes=stat.st_size,
            expires_at=stat.st_mtime + self._ttl_seconds,
        )
        if artefact.is_expired:
            # Remove on access rather than waiting for the sweeper: the user is
            # here now and we already know the answer.
            path.unlink(missing_ok=True)
            raise ArtifactNotFoundError(expired=True)
        return artefact

    def read(self, handle: str) -> bytes:
        """Read an artefact's bytes, enforcing expiry."""
        artefact = self.get(handle)
        try:
            return artefact.path.read_bytes()
        except FileNotFoundError:
            raise ArtifactNotFoundError() from None

    def delete(self, handle: str) -> bool:
        """Remove one artefact. Returns whether a file was actually removed."""
        if not is_artifact_handle(handle):
            return False
        path = self._path_for(handle)
        if not path.exists():
            return False
        path.unlink(missing_ok=True)
        logger.info("artefact deleted", extra={"handle": handle})
        return True

    def sweep(self, *, now: float | None = None) -> int:
        """Delete every expired artefact. Returns how many were removed.

        Called on a timer (Phase 3 wires the task into the app lifespan) and
        available for tests and for a shutdown sweep.
        """
        import time

        cutoff = time.time() if now is None else now
        removed = 0
        for path in self._iter_paths():
            try:
                if path.stat().st_mtime + self._ttl_seconds <= cutoff:
                    path.unlink(missing_ok=True)
                    removed += 1
            except FileNotFoundError:
                # Raced with another sweep; the goal is already met.
                continue
        if removed:
            logger.info("artefact sweep", extra={"removed": removed})
        return removed

    def clear(self) -> None:
        """Remove the whole storage tree. Used on shutdown and in tests."""
        shutil.rmtree(self._root, ignore_errors=True)
        self._root.mkdir(parents=True, exist_ok=True)
        try:
            # `clear` recreates the directory, so the tight mode has to be
            # reapplied rather than assumed to survive.
            self._root.chmod(0o700)
        except OSError:  # pragma: no cover - non-POSIX filesystem
            logger.warning("could not tighten permissions on temp storage")

    def _iter_paths(self) -> Iterator[Path]:
        """Yield artefact paths, skipping anything not created by this store."""
        if not self._root.exists():
            return
        for path in self._root.iterdir():
            if path.is_file() and path.name.startswith(ARTEFACT_PREFIX):
                yield path

    def _path_for(self, handle: str) -> Path:
        """Map a handle to a path.

        `is_artifact_handle` has already guaranteed the shape is
        `art_` + 32 hex characters, so this cannot escape `_root`.
        """
        return self._root / f"{ARTEFACT_PREFIX}{handle}"


def detect_media_type(path: Path) -> str:
    """Identify an artefact from its leading bytes.

    The type is a property of the content, not of what a caller said when
    storing it, and it is derived fresh on every read so it cannot drift. Only the
    formats this application stores — §7's images and Phase 7's liveness recordings
    — are servable; anything else stays opaque rather than being sent to a browser
    under a guessed content type.
    """
    try:
        with path.open("rb") as handle:
            head = handle.read(_SIGNATURE_PROBE_BYTES)
    except OSError:
        return UNKNOWN_MEDIA_TYPE

    detected = sniff_media_type(head)
    if detected in SERVABLE_MEDIA_TYPES:
        return detected
    return UNKNOWN_MEDIA_TYPE
