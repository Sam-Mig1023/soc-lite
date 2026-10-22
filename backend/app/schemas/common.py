"""SOC-Lite · Esquemas Pydantic: comunes (paginación, errores, filtros)."""
from __future__ import annotations

from datetime import datetime
from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class PageParams(BaseModel):
    page: int = Field(1, ge=1, description="Página (1-indexada)")
    page_size: int = Field(25, ge=1, le=200, description="Elementos por página")


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int
    pages: int

    @classmethod
    def build(cls, items: list[T], total: int, page: int, page_size: int) -> "Page[T]":
        pages = (total + page_size - 1) // page_size if page_size else 0
        return cls(items=items, total=total, page=page, page_size=page_size, pages=pages)


class DateRange(BaseModel):
    date_from: datetime | None = Field(None, alias="from")
    date_to: datetime | None = Field(None, alias="to")


class ErrorResponse(BaseModel):
    detail: str
    code: str = "INTERNAL_ERROR"
    trace_id: str | None = None


class MessageResponse(BaseModel):
    message: str
    detail: str | None = None


class BulkIds(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)


class BulkResult(BaseModel):
    updated: int
    skipped: int = 0
    errors: list[str] = Field(default_factory=list)


class CountByKey(BaseModel):
    key: str
    label: str | None = None
    value: int


class SeriesPoint(BaseModel):
    period: str
    value: float
    label: str | None = None
