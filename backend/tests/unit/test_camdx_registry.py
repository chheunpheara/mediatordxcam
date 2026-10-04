"""The six-API registry (§3, §20).

The plan forbids inventing a seventh API or renaming one, and `VerificationMethod`
promises a 1:1 mapping to an adapter module. These tests are what make that
promise checkable rather than aspirational — they fail if an API is added without
an adapter, or if an adapter starts answering for the wrong one.
"""

from __future__ import annotations

import pytest

from app.domain.enums import VerificationMethod
from app.integrations.camdx.services import (
    CAMDX_API_MODULES,
    OCR_ADAPTERS,
    VERIFICATION_PROVIDERS,
    build_verify_provider,
)


def test_every_one_of_the_six_apis_has_an_adapter() -> None:
    """§3: the application must represent exactly the six official APIs."""
    assert set(CAMDX_API_MODULES) == set(VerificationMethod)
    assert len(CAMDX_API_MODULES) == 6


def test_the_registry_holds_no_seventh_api() -> None:
    """§3: do not invent additional CamDX APIs.

    A seventh member here would be an API we would have to support and cannot.
    """
    assert len(VerificationMethod) == 6


@pytest.mark.parametrize(
    ("method", "module"),
    [
        (VerificationMethod.VERIFY_USER_INFO, "verify_user_info"),
        (VerificationMethod.VERIFY_USER_INFO_FACE, "verify_user_face"),
        (VerificationMethod.VERIFY_USER_INFO_IDCARD_FACE, "verify_user_idcard_face"),
        (VerificationMethod.VERIFY_USER_INFO_IDCARD_LIVENESS, "verify_user_liveness"),
        (VerificationMethod.KHMER_ID_CARD_OCR, "idcard_ocr"),
        (VerificationMethod.PASSPORT_OCR, "passport_ocr"),
    ],
)
def test_each_api_maps_to_the_module_the_plan_names(method, module: str) -> None:
    """§20 names six modules; the mapping must match them one for one."""
    assert CAMDX_API_MODULES[method] == module


@pytest.mark.parametrize("method", list(VERIFICATION_PROVIDERS))
def test_each_verify_provider_declares_the_method_it_implements(method) -> None:
    """A provider wired to the wrong API would verify through the wrong rules.

    §4's liveness substitution, for instance, is a materially different check from
    API 3's current-face comparison; swapping the two silently would verify with
    inputs the method never declared.
    """
    assert build_verify_provider(method).method == method


@pytest.mark.parametrize("method", list(OCR_ADAPTERS))
def test_each_ocr_adapter_declares_its_method(method) -> None:
    assert OCR_ADAPTERS[method].method == method


def test_the_two_ocr_apis_are_not_verify_operations() -> None:
    """API 5 and 6 read documents; they are not things `POST /verify` runs.

    Registering them as verification providers would let a caller "verify" by
    reading a passport, which cannot answer any of the four questions APIs 1 to 4 ask.
    """
    assert set(OCR_ADAPTERS).isdisjoint(VERIFICATION_PROVIDERS)
    assert not set(OCR_ADAPTERS) & set(VERIFICATION_PROVIDERS)


def test_building_an_ocr_provider_is_refused() -> None:
    with pytest.raises(ValueError, match="not a verification method"):
        build_verify_provider(VerificationMethod.PASSPORT_OCR)
