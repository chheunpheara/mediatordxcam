"""Dependency-injection providers.

`Depends` targets live here so endpoint modules stay thin and so tests can
override a single provider without patching module globals.

Settings are cached for the process lifetime. Services arrive in Phase 3+
(`TempArtifactStore`, `FaceService`, `KycService`, `CamDXProvider`); the
provider functions are added in the same phase as the service they build, so no
placeholder exists that does not correspond to real code.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends

from app.core.config import Settings, get_settings


def settings_provider() -> Settings:
    """Return the process-wide settings."""
    return get_settings()


SettingsDep = Annotated[Settings, Depends(settings_provider)]
