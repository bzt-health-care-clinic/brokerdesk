from pathlib import Path
from PIL import Image, ImageEnhance, ImageOps
import pypdfium2 as pdfium


ORIENTATION_ROTATIONS = {3: 180, 6: 90, 8: 270}


def prepare_image(source: Path, destination: Path, enable_contrast: bool) -> tuple[Path, int | None]:
    with Image.open(source) as original:
        exif = original.getexif()
        rotation = ORIENTATION_ROTATIONS.get(exif.get(274), 0)
        image = ImageOps.exif_transpose(original).convert("RGB")
        shortest = min(image.size)
        if shortest and shortest < 1000:
            scale = 1000 / shortest
            image = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
        if enable_contrast:
            image = ImageEnhance.Contrast(ImageOps.grayscale(image)).enhance(1.25).convert("RGB")
        image.save(destination, "PNG")
    return destination, rotation


def render_pdf(source: Path, output_dir: Path) -> list[Path]:
    document = pdfium.PdfDocument(str(source))
    pages: list[Path] = []
    try:
        for index in range(len(document)):
            page = document[index]
            bitmap = page.render(scale=2.0)
            image = bitmap.to_pil().convert("RGB")
            destination = output_dir / f"page-{index + 1}.png"
            image.save(destination, "PNG")
            pages.append(destination)
            page.close()
    finally:
        document.close()
    return pages
