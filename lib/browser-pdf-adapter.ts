"use client";

import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&url";
import workerSource from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw";
import { normalizeOcrText } from "./document-ingestion";
import { pdfTextLines } from "./pdf-text-lines";
import { pdfLayoutPage } from "./pdf-layout";
import type { PdfPageAdapter, PdfPageSource } from "./package-analysis";

let configured = false;
async function loadBrowserPdfJs() {
  if (typeof window === "undefined") throw new Error("PDF page analysis is available in the browser only.");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!configured) {
    // Vite 8's dev worker route prepends /@vite/client, which reads window in a
    // Worker global. Use the same Vite-imported worker bytes as a module Blob
    // in dev; production keeps Vite's emitted worker asset URL.
    pdfjs.GlobalWorkerOptions.workerSrc = import.meta.env.DEV
      ? URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }))
      : workerUrl;
    configured = true;
  }
  return pdfjs;
}

export class BrowserPdfPageAdapter implements PdfPageAdapter {
  async open(file: File): Promise<PdfPageSource> {
    const pdfjs = await loadBrowserPdfJs();
    const pdfDocument = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useSystemFonts: true }).promise;
    return {
      pageCount: pdfDocument.numPages,
      async embeddedText(pageNumber) { const page = await pdfDocument.getPage(pageNumber); const content = await page.getTextContent(); return normalizeOcrText(pdfTextLines(content.items.map((item) => "str" in item ? item : {}))); },
      async embeddedPage(pageNumber) {
        const page = await pdfDocument.getPage(pageNumber);
        const content = await page.getTextContent();
        return pdfLayoutPage(content.items.map(item => "str" in item ? item : {}), page.getViewport({scale:1}), pageNumber);
      },
      async renderPage(pageNumber, targetBytes) {
        const page = await pdfDocument.getPage(pageNumber); let scale = 2.8; let quality = .88; let output: Blob | null = null;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const viewport = page.getViewport({ scale }); const canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); const context = canvas.getContext("2d", { alpha: false }); if (!context) throw new Error("PDF page rendering is unavailable.");
          await page.render({ canvas, canvasContext: context, viewport }).promise; output = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality)); canvas.width = 1; canvas.height = 1;
          if (output && output.size <= targetBytes) break; scale *= .82; quality = Math.max(.58, quality - .09);
        }
        if (!output || output.size > targetBytes) throw new Error("Rendered page could not be reduced below the OCR provider limit without unsafe degradation.");
        return new File([output], `${file.name.replace(/\.pdf$/i, "")}-page-${pageNumber}.jpg`, { type: "image/jpeg" });
      },
      async close() { await pdfDocument.destroy(); },
    };
  }
}
