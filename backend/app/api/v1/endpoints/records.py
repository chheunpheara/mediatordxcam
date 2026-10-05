"""Uploaded records: bulk CSV/Excel rows, their mapping, their status (D23).

Every route sits behind `current_user` — any signed-in account, because the
people who upload rows are the same Loan Officers who verify them (unlike
`/integrations`, which needs the full six-permission set). The endpoints stay
thin: query parsing, response assembly, and the `VerifyResponse` handed
straight to the service — validation, storage and the list's filter logic
live in `RecordService`.

Routes:

```text
GET    /api/v1/records                            one page of the list
POST   /api/v1/records                            add the reviewed rows
POST   /api/v1/records/{record_id}/verification   store an outcome (D23)
GET    /api/v1/records/mappings                   the saved column mapping
PUT    /api/v1/records/mappings                   save the column mapping
```

The file itself never arrives here: the browser parses the CSV or Excel and
submits only the mapped values, so the server holds identity data the user
chose to submit and nothing else (§29).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.api.deps import CurrentUserDep, RecordServiceDep, current_user
from app.infrastructure.record_store import StoredRecord
from app.schemas.records import (
    CreateRecordsRequest,
    CreateRecordsResponse,
    RecordListResponse,
    RecordMappingResponse,
    RecordResponse,
    RecordStatus,
    SaveRecordMappingRequest,
    SaveRecordVerificationRequest,
    StoredVerification,
)
from app.schemas.verification import UserInformation

router = APIRouter(
    prefix="/api/v1/records",
    tags=["records"],
    dependencies=[Depends(current_user)],
)

#: `GET /records` query contract: a substring across the values, an optional
#: status filter, and a bounded page (1-50 rows) with an offset into the total.
SearchParam = Annotated[
    str | None, Query(max_length=200, description="Substring match across values.")
]
StatusParam = Annotated[RecordStatus | None, Query(description="Keep only this status.")]
LimitParam = Annotated[int, Query(ge=1, le=50, description="Page size.")]
OffsetParam = Annotated[int, Query(ge=0, description="Rows to skip.")]


@router.get("/mappings", response_model=RecordMappingResponse)
async def get_mapping(service: RecordServiceDep, _user: CurrentUserDep) -> RecordMappingResponse:
    """The one reusable column mapping, or `None` if nothing was saved yet."""
    return RecordMappingResponse(mapping=await service.get_mapping())


@router.put("/mappings", response_model=RecordMappingResponse)
async def save_mapping(
    body: SaveRecordMappingRequest,
    service: RecordServiceDep,
    _user: CurrentUserDep,
) -> RecordMappingResponse:
    """Replace the reusable column mapping (D23).

    One default mapping, like the posting settings — the dialog pre-applies it
    whenever the next file's columns line up with what was saved.
    """
    return RecordMappingResponse(mapping=await service.save_mapping(dict(body.mapping)))


@router.get("", response_model=RecordListResponse)
async def list_records(
    service: RecordServiceDep,
    _user: CurrentUserDep,
    search: SearchParam = None,
    status: StatusParam = None,
    limit: LimitParam = 10,
    offset: OffsetParam = 0,
) -> RecordListResponse:
    """One page of the list — search, status filter and paging in one call."""
    records, total = await service.list_records(
        search=search, status=status, limit=limit, offset=offset
    )
    return RecordListResponse(records=[_record_response(item) for item in records], total=total)


@router.post("", response_model=CreateRecordsResponse, status_code=201)
async def create_records(
    body: CreateRecordsRequest,
    service: RecordServiceDep,
    _user: CurrentUserDep,
) -> CreateRecordsResponse:
    """Add the reviewed rows from a CSV/Excel upload (D23).

    The values arrive as §14 field names — the mapping already happened in the
    browser — so what is stored is exactly what the identity form will show
    when someone starts verifying a row.
    """
    stored = await service.create_records([row.model_dump() for row in body.records])
    return CreateRecordsResponse(records=[_record_response(item) for item in stored])


@router.post("/{record_id}/verification", response_model=RecordResponse)
async def save_verification(
    record_id: str,
    body: SaveRecordVerificationRequest,
    service: RecordServiceDep,
    _user: CurrentUserDep,
) -> RecordResponse:
    """Store a run's outcome on its record and mark it verified (D23).

    The outcome is the same `VerifyResponse` `POST /verify` returned, submitted
    by the browser once the run finished while that record was on screen; the
    server stamps `verifiedAt` itself so the list's Status column and the
    Preview dialog share one clock.
    """
    stored = await service.save_verification(record_id, body.verification.model_dump(mode="json"))
    return _record_response(stored)


def _record_response(record: StoredRecord) -> RecordResponse:
    """The wire shape — the store's plain dict rebuilt as typed schemas."""
    verification = None
    if record.verification is not None and record.verified_at is not None:
        verification = StoredVerification(**record.verification, verifiedAt=record.verified_at)
    return RecordResponse(
        id=record.id,
        status=record.status,
        values=UserInformation(**record.values),
        verification=verification,
        createdAt=record.created_at,
        verifiedAt=record.verified_at,
    )
