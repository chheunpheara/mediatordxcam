"""Schemas for the bulk record upload (D23).

The upload itself never reaches the server: the browser reads the CSV or Excel
file, the mapper pairs its columns with the nine §14 fields, and only the
resulting values are submitted here — so this API carries identity data the
user chose, never a file (§29).

`values` reuses `UserInformation` (§19's "user information") because that is
literally what a record is: the same nine fields the verify form sends, held
until someone starts a verification. Every field is optional so a partial
mapping still stores; the form fills the gaps before verify.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from app.schemas.common import ApiModel
from app.schemas.verification import UserInformation, VerifyResponse

#: A record's lifecycle in the list: waiting for a run, or already verified.
RecordStatus = Literal["pending", "verified"]

#: The saved column mapping, keys are file column names (D23). The values are
#: restricted to the §14 field names, so a stray name is a 400 keyed
#: `mapping.<column>` rather than something stored and later ignored.
IdentityFieldKey = Literal[
    "nationalId",
    "firstNameKhmer",
    "lastNameKhmer",
    "firstNameEnglish",
    "lastNameEnglish",
    "gender",
    "dateOfBirth",
    "issuedDate",
    "expiryDate",
]


class CreateRecordsRequest(ApiModel):
    """`POST /api/v1/records` — the reviewed rows, one entry per file row."""

    records: list[UserInformation] = Field(
        min_length=1,
        max_length=500,
        description="Reviewed rows; 1-500 per submission.",
    )


class StoredVerification(VerifyResponse):
    """A stored outcome plus when it was recorded (D23)."""

    verifiedAt: float = Field(description="Unix timestamp of the verification run.")


class RecordResponse(ApiModel):
    """One row of the uploaded-records list."""

    id: str
    status: RecordStatus
    values: UserInformation = Field(description="The nine §14 fields as mapped.")
    verification: StoredVerification | None = Field(
        default=None,
        description="The stored outcome; present once the record is verified.",
    )
    createdAt: float
    verifiedAt: float | None = None


class RecordListResponse(ApiModel):
    """One page of records plus how many the filter matched in total."""

    records: list[RecordResponse]
    total: int


class CreateRecordsResponse(ApiModel):
    """What a submission created (the list refreshes itself afterwards)."""

    records: list[RecordResponse]


class SaveRecordVerificationRequest(ApiModel):
    """`POST /api/v1/records/{record_id}/verification` (D23).

    The outcome arrives exactly as `POST /verify` returned it — the same
    `VerifyResponse` shape with no extra fields — and the server stamps
    `verifiedAt` itself.
    """

    verification: VerifyResponse


class RecordMappingResponse(ApiModel):
    """The saved column mapping, or `None` when nothing was saved yet."""

    mapping: dict[str, IdentityFieldKey] | None = None


class SaveRecordMappingRequest(ApiModel):
    """`PUT /api/v1/records/mappings` — the one reusable default mapping."""

    mapping: dict[str, IdentityFieldKey] = Field(
        max_length=50,
        description="File column name → §14 field name; at most 50 entries.",
    )
