import type { ExtractionInput, ExtractionProvider, RawExtractedDocument } from "./extraction-types.ts";
import { BrowserFileStore } from "./document-ingestion.ts";
import type { OcrServerHealth } from "./ocr-providers.ts";

/** Loopback-only transport. Never falls back to cloud OCR. */
export class HttpLocalTesseractTransport {
  private endpoint:string;
  constructor(endpoint = `${process.env.NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL ?? "http://127.0.0.1:47831"}/local-ocr`) {
    const target=new URL(endpoint);
    if(target.protocol!=="http:" || !["127.0.0.1","localhost","[::1]"].includes(target.hostname) ||
      target.username || target.password || target.pathname!=="/local-ocr")
      throw new Error("Local OCR endpoint must use loopback HTTP.");
    this.endpoint=target.toString();
  }
  async health(): Promise<OcrServerHealth> {
    try {
      const response=await fetch(`${this.endpoint}/health`, { cache:"no-store" });
      if (!response.ok) return { state:"OFFLINE", provider:"local_tesseract" };
      return await response.json() as OcrServerHealth;
    } catch { return { state:"OFFLINE", provider:"local_tesseract" }; }
  }
  async extract(file:File): Promise<RawExtractedDocument> {
    const form=new FormData();
    form.append("file",file,file.name);
    const response=await fetch(this.endpoint,{ method:"POST",body:form });
    const result=await response.json().catch(()=>({})) as RawExtractedDocument & {error?:string;code?:string};
    if (!response.ok) throw Object.assign(new Error(result.error??"Local OCR failed"),{code:result.code??"OCR_LOCAL_FAILED"});
    if (result.metadata?.provider!=="local_tesseract")
      throw new Error("Unexpected local OCR response provider.");
    return result;
  }
}
export class LocalTesseractProvider implements ExtractionProvider {
  readonly id="local_tesseract";
  readonly status="READY" as const;
  constructor(private store:BrowserFileStore, private transport:HttpLocalTesseractTransport){}
  async canHandle(input:ExtractionInput){
    return /^image\/(?:jpeg|png)$/i.test(input.mimeType) || /\.(?:jpg|jpeg|png)$/i.test(input.fileName);
  }
  async extract(input:ExtractionInput):Promise<RawExtractedDocument>{
    const file=this.store.get(input.fileId);
    if(!file)throw new Error("Original local image is unavailable.");
    const result=await this.transport.extract(file);
    return {...result,metadata:{...result.metadata,provider:this.id,requiresBrokerVerification:true}};
  }
}
