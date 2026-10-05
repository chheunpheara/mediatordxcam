"""The requirement engine (§11).

§11 insists the backend validate requirements independently and that the UI learn
them from configuration. Both properties are tested here against the same table,
because the failure this guards against is quiet: a method that asks for an input
the backend never checks would look complete and let an unsatisfiable request
through.
"""

from __future__ import annotations

import pytest

from app.domain.enums import RequirementFlag, VerificationMethod
from app.domain.requirements import (
    IDENTITY_FIELD_NAMES,
    METHOD_REQUIREMENTS,
    requirements_for,
)

FULL_IDENTITY: dict[str, str] = dict.fromkeys(IDENTITY_FIELD_NAMES, "value")


def missing(
    method: VerificationMethod,
    **overrides: object,
) -> tuple[RequirementFlag, ...]:
    from app.domain.requirements import missing_requirements

    kwargs: dict[str, object] = {
        "identity": FULL_IDENTITY,
        "id_card_ref": "art_document",
        "current_face_ref": "art_face",
        "liveness_ref": "art_liveness",
    }
    kwargs.update(overrides)
    return missing_requirements(method, **kwargs)  # type: ignore[arg-type]


def test_the_table_covers_every_method_exactly_once() -> None:
    assert set(METHOD_REQUIREMENTS) == set(VerificationMethod)
    assert len(METHOD_REQUIREMENTS) == 6


def test_api_1_needs_only_identity_information() -> None:
    """§10: API 1 asks for identity information and nothing else."""
    assert missing(VerificationMethod.VERIFY_USER_INFO) == ()


@pytest.mark.parametrize(
    ("method", "flag"),
    [
        (VerificationMethod.VERIFY_USER_INFO_FACE, RequirementFlag.CURRENT_FACE),
        (VerificationMethod.VERIFY_USER_INFO_IDCARD_FACE, RequirementFlag.CURRENT_FACE),
        (VerificationMethod.VERIFY_USER_INFO_IDCARD_FACE, RequirementFlag.ID_CARD),
        (VerificationMethod.VERIFY_USER_INFO_IDCARD_LIVENESS, RequirementFlag.ID_CARD),
        (VerificationMethod.VERIFY_USER_INFO_IDCARD_LIVENESS, RequirementFlag.LIVENESS),
    ],
)
def test_each_method_names_its_own_extra_input(method, flag) -> None:
    """§10: each method asks only for its required inputs."""
    assert missing(method, **{_snake(flag): None}) == (flag,)


def test_missing_flags_are_reported_not_a_single_generic_error() -> None:
    """§11: the UI branches on flags, so every absent input must be listed."""
    result = missing(VerificationMethod.VERIFY_USER_INFO_IDCARD_LIVENESS, liveness_ref=None)

    assert set(result) == {RequirementFlag.LIVENESS}


def test_an_identity_with_one_blank_field_is_not_supplied() -> None:
    """§16: an incomplete form must not be sent as if it were complete.

    §14 lets the user leave a field for later; the gate must still notice, or a
    government API answers with a failure the user cannot act on.
    """
    partial = {**FULL_IDENTITY, "dateOfBirth": "  "}

    assert missing(VerificationMethod.VERIFY_USER_INFO, identity=partial) == (
        RequirementFlag.USER_INFO,
    )


def test_an_absent_identity_is_not_supplied() -> None:
    assert missing(VerificationMethod.VERIFY_USER_INFO, identity=None) == (
        RequirementFlag.USER_INFO,
    )


def test_an_empty_reference_does_not_count_as_supplied() -> None:
    """An empty string is a missing input, not a valid handle."""
    assert missing(VerificationMethod.VERIFY_USER_INFO_FACE, current_face_ref="") == (
        RequirementFlag.CURRENT_FACE,
    )


def test_api_4_can_never_be_satisfied_here() -> None:
    """`:1355`: API 4 must not execute without liveness state.

    Phase 7 introduces liveness, so no combination of today's inputs satisfies
    API 4. `available: false` on its method card is the honest answer.
    """
    assert not requirements_for(VerificationMethod.VERIFY_USER_INFO_IDCARD_LIVENESS).is_satisfiable
    assert not missing(VerificationMethod.VERIFY_USER_INFO_IDCARD_LIVENESS)


def test_currently_runnable_methods() -> None:
    """The phase state, asserted so it is revisited when a phase lands."""
    runnable = {
        m
        for m in VerificationMethod
        if requirements_for(m).is_satisfiable and not requirements_for(m).is_ocr
    }

    assert runnable == {
        VerificationMethod.VERIFY_USER_INFO,
        VerificationMethod.VERIFY_USER_INFO_FACE,
        VerificationMethod.VERIFY_USER_INFO_IDCARD_FACE,
    }


def test_a_passport_is_never_counted_as_supplied() -> None:
    """Passport capture is Phase 8, so API 6's only requirement is always unmet.

    The gate deliberately takes no passport reference at all: accepting one now
    would create a parameter no caller can satisfy and no code reads.
    """
    assert missing(VerificationMethod.PASSPORT_OCR) == (RequirementFlag.PASSPORT,)
    assert not requirements_for(VerificationMethod.PASSPORT_OCR).is_satisfiable


def _snake(flag: RequirementFlag) -> str:
    """Map a requirement flag to the kwarg the gate takes."""
    return {
        RequirementFlag.CURRENT_FACE: "current_face_ref",
        RequirementFlag.ID_CARD: "id_card_ref",
        RequirementFlag.LIVENESS: "liveness_ref",
    }[flag]
