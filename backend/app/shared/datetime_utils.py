"""UTC datetime serialization helpers.

Backend stores naive datetimes (DB columns default to TIMESTAMP WITHOUT
TIME ZONE) but logically treats them as UTC (`datetime.utcnow()` writes,
no per-row tz column). Without an explicit timezone marker on the wire,
`new Date(iso)` in browsers interprets the ISO string as LOCAL time —
shifting display by the user's UTC offset (KST → -9h).

`UtcDatetime` is a Pydantic annotation that stamps the UTC offset on
the way out so JS clients parse the same moment correctly. Use it on
every `datetime` field exposed in any API response.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from pydantic import PlainSerializer


def _serialize_utc(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


UtcDatetime = Annotated[datetime, PlainSerializer(_serialize_utc, return_type=str)]
