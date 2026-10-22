import type { ExtractedBlock, ExtractedPage } from './extraction-types.ts';

/** Cloud/local OCR boxes are image-pixel coordinates, never native PDF points.
 * A block becomes usable for field evidence only when image dimensions,
 * unrotated orientation and the provider's own confidence are present. */
export function trustedOcrPage(ocr: ExtractedPage | undefined, pdf: ExtractedPage | undefined, physicalPage: number) {
  const width = Number(pdf?.width), height = Number(pdf?.height);
  const imageWidth = Number(ocr?.width), imageHeight = Number(ocr?.height);
  const oriented = ocr?.rotation === 0;
  const dimensions = [width,height,imageWidth,imageHeight].every(n=>Number.isFinite(n)&&n>1);
  if (!oriented || !dimensions) return { page: physicalPage, pageNumber: physicalPage, width, height,
    blocks: [] as ExtractedBlock[], trusted: false, reason: 'OCR layout has missing dimensions or unverified orientation.' };
  const output: ExtractedBlock[] = [];
  let invalid = 0;
  for (const cell of ocr?.blocks ?? []) {
    const b = cell.boundingBox;
    const confidence = cell.confidence;
    if (!b || !cell.text?.trim() || !Number.isFinite(confidence) || confidence! < 0 || confidence! > 1 ||
      [b.x,b.y,b.width,b.height].some(v=>!Number.isFinite(v)) || b.x<0 || b.y<0 || b.width<=0 || b.height<=0 ||
      b.x+b.width>imageWidth+1 || b.y+b.height>imageHeight+1) {invalid++;continue;}
    output.push({text:cell.text,confidence,
      boundingBox:{x:b.x*width/imageWidth,y:b.y*height/imageHeight,
        width:b.width*width/imageWidth,height:b.height*height/imageHeight}});
  }
  const trusted=output.length>0 && invalid===0;
  return {page:physicalPage,pageNumber:physicalPage,width,height,blocks:trusted?output:[] as ExtractedBlock[],trusted,
    reason:trusted?undefined:invalid?'OCR contained invalid/partial coordinate evidence. No form values accepted.':'OCR did not provide individual confidence-scored text boxes.'};
}
