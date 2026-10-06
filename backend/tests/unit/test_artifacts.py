"""Temporary artefact store (§29).

The store is the boundary that keeps biometric files from becoming a file server,
so these tests are mostly about what it *refuses* to do: unknown handles,
malformed handles, traversal attempts and expired artefacts.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from app.core.errors import AppError, ErrorCode
from app.core.ids import new_artifact_handle
from app.services.artifacts import TempArtifactStore


@pytest.fixture
def store(tmp_path: Path) -> TempArtifactStore:
    return TempArtifactStore(tmp_path / "tmp", ttl_seconds=900)


def test_stores_and_reads_back_the_exact_bytes(store: TempArtifactStore) -> None:
    payload = b"pretend-this-is-an-id-card"

    handle = store.put(payload, media_type="image/jpeg").handle

    assert store.read(handle) == payload


def test_storage_directory_is_not_world_readable(tmp_path: Path) -> None:
    """A 0700 directory: other users on the host must not read biometrics."""
    store = TempArtifactStore(tmp_path / "tmp", ttl_seconds=900)

    assert store.root.stat().st_mode & 0o077 == 0


def test_stored_files_are_not_world_readable(store: TempArtifactStore) -> None:
    artefact = store.put(b"secret", media_type="image/jpeg")

    assert artefact.path.stat().st_mode & 0o077 == 0


def test_the_handle_never_contains_a_path(store: TempArtifactStore) -> None:
    """The handle is the only thing the client learns (§29)."""
    artefact = store.put(b"x", media_type="image/jpeg")

    assert "/" not in artefact.handle
    assert str(store.root) not in artefact.handle
    assert ".." not in artefact.handle


def test_unknown_handle_is_reported_as_not_found(store: TempArtifactStore) -> None:
    with pytest.raises(AppError) as excinfo:
        store.get(new_artifact_handle())

    assert excinfo.value.code is ErrorCode.ARTIFACT_NOT_FOUND


def test_expired_artefact_reports_expired_not_missing(tmp_path: Path) -> None:
    """The client shows a different message for the two cases (§28)."""
    store = TempArtifactStore(tmp_path / "tmp", ttl_seconds=1)
    handle = store.put(b"x", media_type="image/jpeg").handle

    time.sleep(1.1)

    with pytest.raises(AppError) as excinfo:
        store.get(handle)
    assert excinfo.value.code is ErrorCode.ARTIFACT_EXPIRED


@pytest.mark.parametrize(
    "handle",
    [
        "../../etc/passwd",
        "/etc/passwd",
        "art_short",
        "art_" + "z" * 32,
        "art_" + "0" * 31,
        "..",
        "",
    ],
)
def test_malformed_handles_are_rejected_without_touching_the_filesystem(
    store: TempArtifactStore,
    handle: str,
) -> None:
    """Traversal is not validated against; it is unrepresentable."""
    with pytest.raises(AppError) as excinfo:
        store.get(handle)

    assert excinfo.value.code is ErrorCode.ARTIFACT_NOT_FOUND


def test_sweep_removes_expired_artefacts_only(tmp_path: Path) -> None:
    store = TempArtifactStore(tmp_path / "tmp", ttl_seconds=900)
    keep = store.put(b"fresh", media_type="image/jpeg").handle

    stale = store.put(b"stale", media_type="image/jpeg").handle
    # Backdate so it looks expired rather than sleeping through the test.
    old = time.time() - 10_000
    import os

    os.utime(store._path_for(stale), (old, old))

    assert store.sweep() == 1
    assert store.get(keep)
    with pytest.raises(AppError):
        store.get(stale)


def test_sweep_ignores_files_it_did_not_create(tmp_path: Path) -> None:
    """A stray file in the temp dir must survive cleanup."""
    store = TempArtifactStore(tmp_path / "tmp", ttl_seconds=900)
    stranger = store.root / "someone-elses-file.txt"
    stranger.write_text("not ours")

    store.sweep(now=time.time() + 10_000)

    assert stranger.exists()


def test_reading_an_expired_artefact_deletes_it(tmp_path: Path) -> None:
    """Access is the moment we know it is stale, so clean up immediately."""
    store = TempArtifactStore(tmp_path / "tmp", ttl_seconds=1)
    artefact = store.put(b"x", media_type="image/jpeg")
    time.sleep(1.1)

    with pytest.raises(AppError):
        store.read(artefact.handle)

    assert not artefact.path.exists()


def test_two_handles_never_collide(store: TempArtifactStore) -> None:
    handles = {store.put(b"x", media_type="image/jpeg").handle for _ in range(50)}

    assert len(handles) == 50


def test_delete_is_idempotent(store: TempArtifactStore) -> None:
    handle = store.put(b"x", media_type="image/jpeg").handle

    assert store.delete(handle) is True
    assert store.delete(handle) is False
    assert store.delete("not-a-handle") is False


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (b"\xff\xd8\xff\xe0" + b"\x00" * 32, "image/jpeg"),
        (b"\x89PNG\r\n\x1a\n" + b"\x00" * 32, "image/png"),
        # Phase 7's recordings: a stored clip must come back identifiable as
        # video, or the artefact route has nothing to serve the teller.
        (b"\x1a\x45\xdf\xa3" + b"\x00" * 32, "video/webm"),
        (b"\x00\x00\x00\x18ftypisom" + b"\x00" * 32, "video/mp4"),
        (b"<html><body>hi</body></html>", "application/octet-stream"),
        (b"GIF89a" + b"\x00" * 32, "application/octet-stream"),
        (b"", "application/octet-stream"),
    ],
)
def test_media_type_is_derived_from_the_bytes(
    store: TempArtifactStore,
    payload: bytes,
    expected: str,
) -> None:
    """The stored content decides the type, so a fetch always knows what it has."""
    handle = store.put(payload, media_type="image/jpeg").handle

    assert store.get(handle).media_type == expected


def test_a_claim_of_a_wrong_type_does_not_survive_the_round_trip(store: TempArtifactStore) -> None:
    """HTML stored while claiming to be a JPEG must not be served as an image."""
    handle = store.put(b"<html>not a face</html>", media_type="image/jpeg").handle

    assert store.get(handle).media_type == "application/octet-stream"


def test_clear_keeps_the_directory_private(tmp_path: Path) -> None:
    """`clear` recreates the directory, so it must re-tighten the mode."""
    store = TempArtifactStore(tmp_path / "tmp", ttl_seconds=900)
    store.put(b"x", media_type="image/jpeg")

    store.clear()

    assert store.root.exists()
    assert store.root.stat().st_mode & 0o077 == 0
    assert list(store.root.iterdir()) == []
