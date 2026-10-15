import asyncio
from contextlib import asynccontextmanager
import logging
from pathlib import Path
import secrets

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile, status

from .config import settings
from .engine import PaddleRuntime
from .models import JobView
from .queue import OcrQueue

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
runtime = PaddleRuntime(settings)
jobs = OcrQueue(settings, runtime)


async def authorize(authorization: str | None = Header(default=None)) -> None:
    if not settings.service_token:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="OCR service token is not configured")
    if not authorization or not secrets.compare_digest(authorization, f"Bearer {settings.service_token}"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.temp_dir.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(runtime.load)
    await jobs.start()
    try:
        yield
    finally:
        await jobs.stop()


app = FastAPI(title="BrokerDesk PaddleOCR Service", version="1.0.0", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok" if runtime.loaded else "degraded", "provider": "paddleocr", "version": runtime.version, "modelLoaded": runtime.loaded, "device": settings.device, "language": settings.language, "queueDepth": jobs.queue.qsize(), "maxConcurrentJobs": settings.max_concurrent_jobs}


async def submit(upload: UploadFile, kind: str) -> JobView:
    content = await upload.read(settings.max_upload_bytes + 1)
    if not content:
        raise HTTPException(status_code=400, detail="Empty upload")
    if len(content) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="Upload exceeds configured size limit")
    suffix = Path(upload.filename or ("document.pdf" if kind == "pdf" else "image.png")).suffix or (".pdf" if kind == "pdf" else ".png")
    try:
        return await jobs.submit(content, suffix, kind)
    except asyncio.QueueFull:
        raise HTTPException(status_code=429, detail="OCR queue is full")


@app.post("/ocr/image", response_model=JobView, dependencies=[Depends(authorize)], status_code=202)
async def ocr_image(file: UploadFile = File(...)):
    if not (file.content_type or "").startswith("image/"):
        raise HTTPException(status_code=415, detail="Expected an image upload")
    return await submit(file, "image")


@app.post("/ocr/pdf", response_model=JobView, dependencies=[Depends(authorize)], status_code=202)
async def ocr_pdf(file: UploadFile = File(...)):
    if file.content_type != "application/pdf" and not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=415, detail="Expected a PDF upload")
    return await submit(file, "pdf")


@app.get("/jobs/{job_id}", response_model=JobView, dependencies=[Depends(authorize)])
async def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown OCR job")
    if job.status.value in {"COMPLETED", "FAILED"}:
        jobs.release(job_id)
    return job


@app.get("/metrics", dependencies=[Depends(authorize)])
async def metrics():
    return jobs.metrics()
