"""Password policy and scrypt credential hashing (D18)."""

from __future__ import annotations

import pytest

from app.domain.auth import PASSWORD_POLICY_MESSAGE, password_policy_violation
from app.services.auth import DEFAULT_ADMIN_PASSWORD, hash_password, verify_password

# -- Policy -------------------------------------------------------------------


def test_the_seeded_admin_password_satisfies_the_policy() -> None:
    assert password_policy_violation(DEFAULT_ADMIN_PASSWORD) is None


def test_eight_characters_with_all_four_classes_is_accepted() -> None:
    assert password_policy_violation("Aa1!aaaa") is None


@pytest.mark.parametrize(
    "password",
    [
        "",  # empty
        "Ab1!",  # too short
        "aaaaaaaaaa1!",  # no upper-case
        "AAAAAAAAAA1!",  # no lower-case
        "Aaaaaaaa!",  # no digit
        "Aaaaaaaaa1",  # no symbol
        "not a password at all",  # spaces are not symbols... and too many rules miss
    ],
)
def test_a_password_missing_a_rule_is_rejected_with_the_policy_sentence(
    password: str,
) -> None:
    violation = password_policy_violation(password)

    assert violation == PASSWORD_POLICY_MESSAGE


def test_a_longer_than_allowed_password_names_the_limit() -> None:
    violation = password_policy_violation("Aa1!" * 40)

    assert violation is not None
    assert "128" in violation


# -- Hashing ------------------------------------------------------------------


def test_hash_and_verify_round_trip() -> None:
    encoded = hash_password("Str0ng!Pass")

    assert encoded.startswith("scrypt$")
    assert verify_password("Str0ng!Pass", encoded) is True


def test_a_wrong_password_does_not_verify() -> None:
    encoded = hash_password("Str0ng!Pass")

    assert verify_password("wrong!Pass1", encoded) is False


def test_two_hashes_of_the_same_password_differ() -> None:
    """A unique salt per hash: identical passwords must not produce equal rows."""
    assert hash_password("Str0ng!Pass") != hash_password("Str0ng!Pass")


def test_a_malformed_stored_hash_answers_false_instead_of_raising() -> None:
    assert verify_password("anything", "not-a-hash") is False
    assert verify_password("anything", "scrypt$abc$def") is False
    assert verify_password("anything", "argon2$1$2$3$4$5") is False
