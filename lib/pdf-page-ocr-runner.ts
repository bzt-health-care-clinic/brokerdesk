import type { PdfPageSource, PageOcrTransport } from "./package-analysis.ts";
import type { ClassificationResult, ExtractedPage, PackagePage } from "./extraction-types.ts";
import { isOcrUnavailable } from "./pdf-page-ocr-status.ts";

type Helpers = {
  needsOcr(text:string):boolean;
  normalize(text:string):string;
  classify(file:string,mime:string,text:string):ClassificationResult;
  geometry(ocr:ExtractedPage|undefined,pdf:ExtractedPage|undefined,page:number):{
    width?:number;height?:number;blocks?:ExtractedPage["blocks"];trusted:boolean;reason?:string;
  };
};
function fnv(input:string|Uint8Array){
  const bytes=typeof input==="string"?new TextEncoder().encode(input):input;
  let value=2166136261;
  for(const b of bytes)value=Math.imul(value^b,16777619);
  return (value>>>0).toString(16);
}
function failed(page:number,status:"NEEDS_OCR"|"OCR_FAILED"|"PDF_RENDER_FAILED",reason:string):PackagePage {
  return {page,pageNumber:page,text:"",confidence:0,extractionProvider:"none",
    extractionStatus:"FAILED",pageOcrStatus:status,
    classification:{documentType:"OTHER",confidence:.1,reason},
    sourceHash:"",error:reason};
}
export async function extractPdfPage(options:{
  source:PdfPageSource;pageNumber:number;fileName:string;ocr:PageOcrTransport;
  maxOcrBytes:number;helpers:Helpers;
}):Promise<PackagePage>{
  const {source,pageNumber,fileName,ocr,maxOcrBytes,helpers}=options;
  let layout:ExtractedPage|undefined;
  let embedded="";
  let failedEmbedded=false;
  try{
    layout=source.embeddedPage?await source.embeddedPage(pageNumber):undefined;
    embedded=layout?.text??await source.embeddedText(pageNumber);
  }catch{failedEmbedded=true;}
  if(!failedEmbedded && !helpers.needsOcr(embedded)){
    return {...layout,page:pageNumber,pageNumber,text:embedded,confidence:.99,
      extractionProvider:"embedded_pdf_text",extractionStatus:"COMPLETE",
      pageOcrStatus:"EMBEDDED_TEXT",
      classification:helpers.classify(fileName,"application/pdf",embedded),
      sourceHash:fnv(embedded)};
  }
  // Blank only if the renderer explicitly proves there are no drawing operators.
  // An all-white image (possibly a faint scan/signature) is NEVER called blank.
  let blank=false;
  if(source.isBlankPage)try{blank=await source.isBlankPage(pageNumber);}catch{}
  if(blank){
    return {page:pageNumber,pageNumber,text:"",confidence:1,
      extractionProvider:"embedded_pdf_text",extractionStatus:"COMPLETE",
      pageOcrStatus:"BLANK_PAGE",sourceHash:fnv(`blank-pdf-page:${pageNumber}`),
      classification:{documentType:"OTHER",confidence:1,reason:"Blank page with no drawing operators."}};
  }
  let derivative:File;
  try{ derivative=await source.renderPage(pageNumber,Math.floor(maxOcrBytes*.9)); }
  catch{ return failed(pageNumber,"PDF_RENDER_FAILED","PDF render failed. Original page requires review."); }
  try{
    const extracted=await ocr.extract(derivative,{pageCount:1,startPage:1,endPage:1});
    const text=helpers.normalize(extracted.text??extracted.pages?.map(p=>p.text??"").join("\n")??"");
    if(!text.trim())throw Object.assign(new Error("OCR returned no text."),{code:"OCR_EMPTY_RESULT"});
    const provider=String(extracted.metadata?.provider??"");
    if(!["local_tesseract","paddle_ocr","ocr_space"].includes(provider))
      throw Object.assign(new Error("Untrusted OCR provider."),{code:"OCR_UNTRUSTED_PROVIDER"});
    const geometry=helpers.geometry(extracted.pages?.[0] as ExtractedPage|undefined,layout,pageNumber);
    return {page:pageNumber,pageNumber,text,width:geometry.width,height:geometry.height,
      blocks:geometry.blocks,ocrGeometryVerified:geometry.trusted,
      rotation:extracted.pages?.[0]?.rotation,
      confidence:Math.min(extracted.confidence??0,geometry.trusted?1:.5),
      extractionProvider:provider as PackagePage["extractionProvider"],
      extractionStatus:"COMPLETE",pageOcrStatus:"COMPLETED",
      classification:helpers.classify(fileName,"image/jpeg",text),
      sourceHash:fnv(new Uint8Array(await derivative.arrayBuffer())),
      error:geometry.trusted?undefined:geometry.reason};
  }catch(cause){
    const unavailable=isOcrUnavailable(cause);
    return failed(pageNumber,unavailable?"NEEDS_OCR":"OCR_FAILED",
      unavailable?"Local OCR not configured or offline.":"OCR failed. Retry locally or review manually.");
  }
}
