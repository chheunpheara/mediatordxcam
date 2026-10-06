"""Payload masking before storage (D25, §29).

The rule the audit trail lives by: the snapshot is evidence of *what was
transmitted*, so the verification decision must survive intact while the
customer data that must not sit in a table at rest does not.
"""

from __future__ import annotations

from app.services.audit import mask_payload


class TestNationalId:
    def test_a_national_id_keeps_only_its_edges(self) -> None:
        masked = mask_payload({"nationalId": "123456789"})

        assert masked == {"nationalId": "123***89"}
        assert "123456789" not in str(masked)

    def test_the_snake_case_key_is_masked_too(self) -> None:
        masked = mask_payload({"national_id": "123456789"})

        assert masked == {"national_id": "123***89"}

    def test_a_short_identifier_is_replaced_wholesale(self) -> None:
        masked = mask_payload({"nationalId": "12345"})

        assert masked == {"nationalId": "***"}

    def test_none_stays_none(self) -> None:
        assert mask_payload({"nationalId": None}) == {"nationalId": None}

    def test_the_submitted_value_beside_a_national_id_field_is_masked(self) -> None:
        """The verify payload carries the ID as `submitted`, not as a key."""
        masked = mask_payload(
            {
                "identity": {
                    "fields": [
                        {"field": "nationalId", "status": "matched", "submitted": "123456789"},
                        {"field": "dateOfBirth", "status": "matched", "submitted": "1994-02-11"},
                    ]
                }
            }
        )

        fields = masked["identity"]["fields"]
        assert fields[0]["submitted"] == "123***89"
        # The decision and the other fields are the evidence: untouched.
        assert fields[0]["status"] == "matched"
        assert fields[1]["submitted"] == "1994-02-11"


class TestSecrets:
    def test_secret_keys_become_stars(self) -> None:
        masked = mask_payload(
            {
                "privateKey": "-----BEGIN KEY-----",
                "apiKey": "sk-live-123",
                "password": "hunter2",
                "token": "abc.def.ghi",
                "refresh_token": "r-1",
            }
        )

        assert masked == {
            "privateKey": "***",
            "apiKey": "***",
            "password": "***",
            "token": "***",
            "refresh_token": "***",
        }

    def test_secrets_inside_lists_are_masked(self) -> None:
        masked = mask_payload([{"api_key": "sk-1"}, {"secret": "s3cr3t"}])

        assert masked == [{"api_key": "***"}, {"secret": "***"}]


class TestEvidenceSurvives:
    def test_the_verification_outcome_is_recorded_verbatim(self) -> None:
        payload = {
            "status": "verified",
            "method": "verify_user_info",
            "identity": {"matchedCount": 9, "incorrectFields": []},
            "face": {"required": False, "verified": None},
            "liveness": {"required": False, "verified": None},
        }

        assert mask_payload(payload) == payload

    def test_a_non_string_national_id_is_masked_not_sliced(self) -> None:
        assert mask_payload({"nationalId": 123456789}) == {"nationalId": "***"}

    def test_the_original_is_never_mutated(self) -> None:
        original = {"nationalId": "123456789", "nested": [{"password": "hunter2"}]}

        mask_payload(original)

        assert original == {"nationalId": "123456789", "nested": [{"password": "hunter2"}]}
