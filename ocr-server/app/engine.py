from pathlib import Path
from statistics import mean
from typing import Any
from paddleocr import PaddleOCR
import paddle

from .config import Settings
from .models import BoundingBox, OcrBlock, OcrPage, RawExtractedDocument
from .preprocessing import prepare_image, render_pdf


def plain_result(result: Any) -> dict[str, Any]:
    value = getattr(result, "json", result)
    if callable(value):
        value = value()
    if isinstance(value, str):
        import json
        value = json.loads(value)
    return value.get("res", value) if isinstance(value, dict) else {}


def box_from_polygon(polygon: Any) -> BoundingBox | None:
    try:
        xs = [float(point[0]) for point in polygon]
        ys = [float(point[1]) for point in polygon]
        return BoundingBox(x=min(xs), y=min(ys), width=max(xs) - min(xs), height=max(ys) - min(ys))
    except (TypeError, ValueError, IndexError):
        return None


def extract_rotation(data: dict[str, Any], fallback: int | None) -> int | None:
    candidates = [data.get("angle"), data.get("rotation"), (data.get("doc_preprocessor_res") or {}).get("angle")]
    for candidate in candidates:
        if candidate in {0, 90, 180, 270, "0", "90", "180", "270"}:
            return int(candidate)
    return fallback


class PaddleRuntime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.model: PaddleOCR | None = None

    @property
    def loaded(self) -> bool:
        return self.model is not None

    @property
    def version(self) -> str:
        import paddleocr
        return getattr(paddleocr, "__version__", "unknown")

    def load(self) -> None:
        paddle.set_device(self.settings.device)
        self.model = PaddleOCR(lang=self.settings.language, use_doc_orientation_classify=True, use_doc_unwarping=True, use_textline_orientation=True)

    def ocr_image(self, path: Path, page_number: int, known_rotation: int | None = None) -> OcrPage:
        if not self.model:
            raise RuntimeError("PaddleOCR model is not loaded")
        results = list(self.model.predict(str(path)))
        blocks: list[OcrBlock] = []
        rotation = known_rotation
        width = height = None
        for result in results:
            data = plain_result(result)
            texts = data.get("rec_texts") or data.get("texts") or []
            scores = data.get("rec_scores") or data.get("scores") or []
            polygons = data.get("rec_polys") or data.get("dt_polys") or []
            rotation = extract_rotation(data, rotation)
            shape = data.get("input_img_shape") or data.get("image_shape")
            if shape and len(shape) >= 2:
                height, width = int(shape[0]), int(shape[1])
            for index, text in enumerate(texts):
                if not str(text).strip():
                    continue
                score = float(scores[index]) if index < len(scores) else None
                polygon = polygons[index] if index < len(polygons) else None
                blocks.append(OcrBlock(text=str(text), confidence=score, boundingBox=box_from_polygon(polygon)))
        page_text = "\n".join(block.text for block in blocks)
        confidence = mean([block.confidence for block in blocks if block.confidence is not None]) if any(block.confidence is not None for block in blocks) else None
        return OcrPage(page=page_number, pageNumber=page_number, text=page_text, confidence=confidence, rotation=rotation, width=width, height=height, blocks=blocks)

    def process(self, source: Path, kind: str, work_dir: Path) -> RawExtractedDocument:
        if kind == "pdf":
            inputs = [(path, None) for path in render_pdf(source, work_dir)]
        else:
            prepared, rotation = prepare_image(source, work_dir / "prepared.png", self.settings.enable_contrast)
            inputs = [(prepared, rotation)]
        pages = [self.ocr_image(path, index + 1, rotation) for index, (path, rotation) in enumerate(inputs)]
        confidences = [page.confidence for page in pages if page.confidence is not None]
        return RawExtractedDocument(text="\n".join(page.text for page in pages), pages=pages, confidence=mean(confidences) if confidences else None, metadata={"provider": "paddleocr", "version": self.version, "device": self.settings.device, "language": self.settings.language})
