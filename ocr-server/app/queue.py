import asyncio
import logging
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from .config import Settings
from .engine import PaddleRuntime
from .models import JobStatus, JobView

logger = logging.getLogger("brokerdesk.ocr")


@dataclass
class WorkItem:
    job_id: str
    kind: str
    source: Path
    work_dir: Path


class OcrQueue:
    def __init__(self, settings: Settings, runtime: PaddleRuntime):
        self.settings = settings
        self.runtime = runtime
        self.queue: asyncio.Queue[WorkItem] = asyncio.Queue(maxsize=settings.max_queue_size)
        self.jobs: dict[str, JobView] = {}
        self.workers: list[asyncio.Task] = []
        self.completed_jobs = 0
        self.failed_jobs = 0
        self.total_processing_seconds = 0.0

    async def start(self) -> None:
        self.settings.temp_dir.mkdir(parents=True, exist_ok=True)
        self.cleanup_abandoned()
        self.workers = [asyncio.create_task(self.worker(index)) for index in range(self.settings.max_concurrent_jobs)]

    async def stop(self) -> None:
        for task in self.workers:
            task.cancel()
        await asyncio.gather(*self.workers, return_exceptions=True)

    def cleanup_abandoned(self) -> None:
        cutoff = time.time() - self.settings.temp_ttl_seconds
        for item in self.settings.temp_dir.iterdir():
            try:
                if item.stat().st_mtime < cutoff:
                    shutil.rmtree(item) if item.is_dir() else item.unlink()
            except OSError:
                logger.warning("cleanup_failed path_type=%s", "directory" if item.is_dir() else "file")

    async def submit(self, content: bytes, suffix: str, kind: str) -> JobView:
        if self.queue.full():
            raise asyncio.QueueFull
        job_id = uuid4().hex
        work_dir = self.settings.temp_dir / job_id
        work_dir.mkdir(mode=0o700)
        source = work_dir / f"source{suffix.lower()}"
        source.write_bytes(content)
        job = JobView(jobId=job_id, status=JobStatus.queued)
        self.jobs[job_id] = job
        await self.queue.put(WorkItem(job_id, kind, source, work_dir))
        logger.info("job_queued job_id=%s file_type=%s", job_id, kind)
        return job

    def get(self, job_id: str) -> JobView | None:
        return self.jobs.get(job_id)

    def release(self, job_id: str) -> None:
        self.jobs.pop(job_id, None)

    async def worker(self, worker_number: int) -> None:
        while True:
            item = await self.queue.get()
            started = time.perf_counter()
            self.jobs[item.job_id] = JobView(jobId=item.job_id, status=JobStatus.processing)
            try:
                result = await asyncio.to_thread(self.runtime.process, item.source, item.kind, item.work_dir)
                elapsed = time.perf_counter() - started
                pages = len(result.pages)
                result.metadata.update({"processingSeconds": elapsed, "averageSecondsPerPage": elapsed / pages if pages else None})
                self.jobs[item.job_id] = JobView(jobId=item.job_id, status=JobStatus.completed, result=result, pages=pages, processingSeconds=elapsed, averageSecondsPerPage=elapsed / pages if pages else None)
                self.completed_jobs += 1
                self.total_processing_seconds += elapsed
                logger.info("job_completed job_id=%s pages=%s duration_seconds=%.3f provider=paddleocr", item.job_id, pages, elapsed)
            except Exception as error:
                elapsed = time.perf_counter() - started
                category = type(error).__name__
                self.jobs[item.job_id] = JobView(jobId=item.job_id, status=JobStatus.failed, errorCategory=category, processingSeconds=elapsed)
                self.failed_jobs += 1
                logger.error("job_failed job_id=%s duration_seconds=%.3f error_category=%s", item.job_id, elapsed, category)
            finally:
                shutil.rmtree(item.work_dir, ignore_errors=True)
                self.queue.task_done()

    def metrics(self) -> dict[str, int | float]:
        return {"queued": self.queue.qsize(), "processingCapacity": self.settings.max_concurrent_jobs, "completed": self.completed_jobs, "failed": self.failed_jobs, "totalProcessingSeconds": round(self.total_processing_seconds, 3)}
