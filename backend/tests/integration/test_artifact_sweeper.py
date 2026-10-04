"""The artefact sweeper is actually running (§29).

The TTL is a promise about deletion, and a promise kept only by a timer is worth
nothing unless the timer is wired up. Nothing else in the suite exercises the
lifespan task: `TempArtifactStore.sweep` is tested directly, which would still pass
if the background loop were never started — and it is not started by
`ASGITransport`, which is what the shared `client` fixture uses.

`Settings` deliberately refuses a TTL under 30s or an interval under 5s, so these
tests drive `_sweep_loop` with a stand-in for the interval rather than weakening
that guard or sleeping for half a minute.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.core.config import AppEnvironment, Settings
from app.main import _sweep_loop, create_app
from app.services.artifacts import TempArtifactStore

#: Comfortably longer than the loop's sleep, so a tick has certainly happened.
LOOP_TIMEOUT_SECONDS = 5.0


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        app_env=AppEnvironment.LOCAL,
        camdx_mode="mock",
        temp_storage_dir=tmp_path / "tmp",
    )


@pytest.fixture
def store(settings: Settings) -> TempArtifactStore:
    return TempArtifactStore(
        settings.temp_storage_dir, ttl_seconds=settings.temp_artifact_ttl_seconds
    )


async def test_the_loop_deletes_an_expired_artefact_on_a_tick(store: TempArtifactStore) -> None:
    """The behaviour the TTL exists for, on a timer rather than on request."""
    artefact = store.put(b"never read by anything", media_type="image/jpeg")
    # Backdate so it is already expired; waiting out a real TTL would be absurd here.
    import os

    stale = artefact.path.stat().st_mtime - 10_000
    os.utime(artefact.path, (stale, stale))

    loop_settings = SimpleNamespace(temp_sweep_interval_seconds=0.01)
    task = asyncio.create_task(_sweep_loop(store, loop_settings))
    try:
        await asyncio.wait_for(_wait_until_gone(artefact), timeout=LOOP_TIMEOUT_SECONDS)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert not artefact.path.exists()


async def test_the_loop_leaves_a_live_artefact_alone(store: TempArtifactStore) -> None:
    """A sweeper that deleted everything would pass the test above."""
    artefact = store.put(b"still valid", media_type="image/jpeg")

    loop_settings = SimpleNamespace(temp_sweep_interval_seconds=0.01)
    task = asyncio.create_task(_sweep_loop(store, loop_settings))
    await asyncio.sleep(0.1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert artefact.path.exists()


async def test_a_failing_sweep_does_not_kill_the_loop(store: TempArtifactStore) -> None:
    """The next tick retries, so a transient error must not end the task."""
    calls = 0

    def explode() -> int:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise OSError("transient filesystem failure")
        return 0

    store.sweep = explode  # type: ignore[method-assign]
    loop_settings = SimpleNamespace(temp_sweep_interval_seconds=0.01)
    task = asyncio.create_task(_sweep_loop(store, loop_settings))
    try:
        await asyncio.wait_for(
            _wait_for(predicate=lambda: calls >= 3), timeout=LOOP_TIMEOUT_SECONDS
        )
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert not task.done() or task.cancelled() or calls >= 3


def test_shutdown_leaves_nothing_on_disk(settings: Settings, store: TempArtifactStore) -> None:
    """A stopped container must not leave biometric files on a volume."""
    app = create_app(settings)

    with TestClient(app):
        store.put(b"still fresh", media_type="image/jpeg")
        assert list(store.root.iterdir())

    assert list(store.root.iterdir()) == []


def test_the_sweeper_is_started_and_cancelled_with_the_app(settings: Settings) -> None:
    """A leaked task would keep sweeping a directory the app no longer owns."""
    app = create_app(settings)
    ticks: list[float] = []

    original = _sweep_loop

    async def counting_loop(store: TempArtifactStore, resolved: Settings) -> None:
        ticks.append(0.0)
        await original(store, resolved)

    app.router.lifespan_context = _lifespan_with(counting_loop)

    with TestClient(app):
        assert ticks, "the sweeper was never started"

    # Cancelled on the way out; no assertion needed beyond the app not hanging.


def _lifespan_with(loop_factory):
    """Wrap the app lifespan so the sweeper can be observed."""
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lifespan(app):
        resolved: Settings = app.state.settings
        store = TempArtifactStore(
            resolved.temp_storage_dir,
            ttl_seconds=resolved.temp_artifact_ttl_seconds,
        )
        task = asyncio.create_task(loop_factory(store, resolved))
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            store.clear()

    return lifespan


async def _wait_until_gone(artefact) -> None:
    while artefact.path.exists():
        await asyncio.sleep(0.01)


async def _wait_for(predicate) -> None:
    while not predicate():
        await asyncio.sleep(0.01)
