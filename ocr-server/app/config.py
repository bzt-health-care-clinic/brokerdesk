from dataclasses import dataclass
import os
from pathlib import Path


def as_bool(value: str) -> bool:
    return value.lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    service_token: str = os.getenv("OCR_SERVICE_TOKEN", "")
    max_concurrent_jobs: int = int(os.getenv("OCR_MAX_CONCURRENT_JOBS", "1"))
    max_queue_size: int = int(os.getenv("OCR_MAX_QUEUE_SIZE", "20"))
    language: str = os.getenv("OCR_LANG", "ch")
    device: str = os.getenv("OCR_DEVICE", "cpu")
    enable_contrast: bool = as_bool(os.getenv("OCR_ENABLE_CONTRAST", "false"))
    temp_dir: Path = Path(os.getenv("OCR_TEMP_DIR", "/tmp/brokerdesk-ocr"))
    temp_ttl_seconds: int = int(os.getenv("OCR_TEMP_TTL_SECONDS", "3600"))
    max_upload_bytes: int = int(os.getenv("OCR_MAX_UPLOAD_BYTES", str(30 * 1024 * 1024)))


settings = Settings()
