export async function GET() {
  const serverUrl = process.env.OCR_SERVER_URL?.replace(/\/$/, "");
  if (!serverUrl) return Response.json({ state: "NOT_CONFIGURED" });
  try {
    const response = await fetch(`${serverUrl}/health`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (!response.ok) return Response.json({ state: "OFFLINE" });
    const health = await response.json() as Record<string, unknown>;
    const state = health.status === "ok" && health.modelLoaded ? "ONLINE" : "DEGRADED";
    return Response.json({ state, ...health });
  } catch { return Response.json({ state: "OFFLINE" }); }
}
