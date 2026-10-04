"""The six-API registry (§3, §20).

`VerificationMethod` claims each member maps 1:1 to an adapter module here. This
module makes that true and keeps it true: the registry is built by importing all
six modules and asserting that every enum member is present exactly once, so a
seventh API or a renamed one fails loudly at import instead of being discovered
when a user picks a method that does nothing.

```text
KYCService
    ↓
this registry
    ├── verify_user_info.py        API 1
    ├── verify_user_face.py        API 2
    ├── verify_user_idcard_face.py API 3
    ├── verify_user_liveness.py    API 4
    ├── idcard_ocr.py              API 5
    └── passport_ocr.py            API 6
```
"""

from __future__ import annotations

from collections.abc import Callable

from app.domain.enums import VerificationMethod
from app.integrations.camdx.services import (
    idcard_ocr,
    passport_ocr,
    verify_user_face,
    verify_user_idcard_face,
    verify_user_info,
    verify_user_liveness,
)
from app.integrations.camdx.verify import VerifyProvider

#: Verification methods → their adapter builder. The four `verify` APIs only;
#: OCR methods are routed by the document flow, not by `POST /verify`.
VERIFICATION_PROVIDERS: dict[VerificationMethod, Callable[[], VerifyProvider]] = {
    VerificationMethod.VERIFY_USER_INFO: verify_user_info.build,
    VerificationMethod.VERIFY_USER_INFO_FACE: verify_user_face.build,
    VerificationMethod.VERIFY_USER_INFO_IDCARD_FACE: verify_user_idcard_face.build,
    VerificationMethod.VERIFY_USER_INFO_IDCARD_LIVENESS: verify_user_liveness.build,
}

#: OCR APIs → their adapter class. Present for completeness of the §3 mapping.
OCR_ADAPTERS: dict[VerificationMethod, type[object]] = {
    VerificationMethod.KHMER_ID_CARD_OCR: idcard_ocr.KhmerIdCardOcrAdapter,
    VerificationMethod.PASSPORT_OCR: passport_ocr.PassportOcrAdapter,
}

#: Every API in the enum maps to exactly one adapter, and every adapter maps back.
CAMDX_API_MODULES: dict[VerificationMethod, str] = {
    **{
        method: builder.__module__.rsplit(".", 1)[-1]
        for method, builder in VERIFICATION_PROVIDERS.items()
    },
    **{method: adapter.__module__.rsplit(".", 1)[-1] for method, adapter in OCR_ADAPTERS.items()},
}


def _assert_one_adapter_per_api() -> None:
    """Fail at import if the mapping is not exactly six ways (§3).

    An enum member with no adapter would surface to the user as a method that is
    listed, selectable, and then silently does nothing.
    """
    if set(CAMDX_API_MODULES) != set(VerificationMethod):
        unmapped = set(VerificationMethod) - set(CAMDX_API_MODULES)
        names = sorted(m.value for m in unmapped)
        raise RuntimeError(f"CamDigiKey APIs without an adapter: {names}")
    if len(CAMDX_API_MODULES) != 6:
        raise RuntimeError(f"expected six CamDigiKey APIs, found {len(CAMDX_API_MODULES)}")


_assert_one_adapter_per_api()


def build_verify_provider(method: VerificationMethod) -> VerifyProvider:
    """Construct the adapter for one verification method.

    Refuses the OCR APIs: they are CamDigiKey operations but not `verify`
    operations, and a caller reaching for one through `POST /verify` has made a
    request that cannot mean anything.
    """
    builder = VERIFICATION_PROVIDERS.get(method)
    if builder is None:
        raise ValueError(f"{method.value} is not a verification method")
    return builder()


__all__ = [
    "CAMDX_API_MODULES",
    "OCR_ADAPTERS",
    "VERIFICATION_PROVIDERS",
    "build_verify_provider",
]
