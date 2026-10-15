from enum import Enum
from typing import Any
from pydantic import BaseModel, Field


class JobStatus(str, Enum):
    queued = "QUEUED"
    processing = "PROCESSING"
    completed = "COMPLETED"
    failed = "FAILED"


class BoundingBox(BaseModel):
    x: float
    y: float
    width: float
    height: float


class OcrBlock(BaseModel):
    text: str
    confidence: float | None = None
    boundingBox: BoundingBox | None = None


class OcrPage(BaseModel):
    page: int
    pageNumber: int
    text: str
    confidence: float | None = None
    rotation: int | None = None
    width: int | None = None
    height: int | None = None
    blocks: list[OcrBlock] = Field(default_factory=list)


class RawExtractedDocument(BaseModel):
    text: str = ""
    pages: list[OcrPage]
    confidence: float | None = None
    metadata: dict[str, Any]


class JobView(BaseModel):
    jobId: str
    status: JobStatus
    result: RawExtractedDocument | None = None
    errorCategory: str | None = None
    pages: int | None = None
    processingSeconds: float | None = None
    averageSecondsPerPage: float | None = None
