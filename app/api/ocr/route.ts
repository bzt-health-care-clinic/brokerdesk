import { NextRequest } from "next/server";

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function POST(request: NextRequest) {
  const serverUrl = process.env.OCR_SERVER_URL?.replace(/\/$/, "");
  const token = process.env.OCR_SERVICE_TOKEN;
  if (!serverUrl || !token) return Response.json({ state: "NOT_CONFIGURED", error: "OCR server is not configured." }, { status: 503 });
  try {
    const incoming = await request.formData();
    const file = incoming.get("file");
    if (!(file instanceof File)) return Response.json({ error: "File is required." }, { status: 400 });
    const path = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf") ? "/ocr/pdf" : "/ocr/image";
    const body = new FormData(); body.append("file", file, file.name);
    const submitted = await fetch(`${serverUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
    if (!submitted.ok) return Response.json({ state: submitted.status === 429 ? "DEGRADED" : "OFFLINE", error: `OCR server rejected the request (${submitted.status}).` }, { status: submitted.status });
    const job = await submitted.json() as { jobId: string; status: string };
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const statusResponse = await fetch(`${serverUrl}/jobs/${encodeURIComponent(job.jobId)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (!statusResponse.ok) return Response.json({ state: "OFFLINE", error: "OCR job status is unavailable." }, { status: 503 });
      const current = await statusResponse.json() as { status: string; result?: unknown; errorCategory?: string };
      if (current.status === "COMPLETED") return Response.json(current.result);
      if (current.status === "FAILED") return Response.json({ state: "DEGRADED", error: `OCR runtime error: ${current.errorCategory ?? "unknown"}` }, { status: 502 });
      await pause(500);
    }
    return Response.json({ state: "DEGRADED", error: "OCR job timed out and can be retried." }, { status: 504 });
  } catch {
    return Response.json({ state: "OFFLINE", error: "OCR SERVER OFFLINE" }, { status: 503 });
  }
}
