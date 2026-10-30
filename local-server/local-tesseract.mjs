/**
 * Step 5B-03: offline OCR. The rendered single-page JPEG/PNG never leaves
 * the loopback BrokerDesk local-server. No external HTTP requests.
 * Tesseract 5.x CLI: Apache-2.0; model files installed separately by user.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

const execFile = promisify(execFileCb);
const MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT = 45000;
function error(message, code, status = 422) {
  return Object.assign(new Error(message), { code, status });
}
export function tesseractConfig(env = process.env) {
  const configured = String(env.BROKERDESK_TESSERACT_EXE || "").trim();
  if (configured && !isAbsolute(configured))
    throw error("BROKERDESK_TESSERACT_EXE must be an absolute local path.", "OCR_INVALID_CONFIG", 503);
  const binary = configured || "tesseract";
  const timeoutMs = Math.min(90000, Math.max(1000, Number(env.BROKERDESK_TESSERACT_TIMEOUT_MS) || DEFAULT_TIMEOUT));
  return { binary, configured: Boolean(configured), timeoutMs, maxFileBytes: MAX_BYTES };
}
export function parseTesseractTsv(tsv) {
  const lines = String(tsv).replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n").filter(Boolean);
  if (!lines[0] || !lines[0].startsWith("level\tpage_num\t"))
    throw error("Local OCR returned invalid TSV.", "OCR_INVALID_TSV", 502);
  const header = lines.shift().split("\t");
  const idx = Object.fromEntries(header.map((field, index) => [field, index]));
  for (const key of ["level", "left", "top", "width", "height", "conf", "text", "line_num", "par_num", "block_num"])
    if (idx[key] === undefined) throw error("Local OCR TSV missing required columns.", "OCR_INVALID_TSV", 502);
  const words = [];
  let imageWidth, imageHeight;
  for (const line of lines) {
    const col = line.split("\t");
    const n = name => Number(col[idx[name]]);
    if (n("level") === 1) { imageWidth = n("width"); imageHeight = n("height"); }
    if (n("level") !== 5) continue;
    const text = col.slice(idx.text).join("\t").trim();
    const conf = n("conf");
    const b = { x: n("left"), y: n("top"), width: n("width"), height: n("height") };
    if (!text || !Number.isFinite(conf) || conf < 0 || conf > 100 ||
        Object.values(b).some(v => !Number.isFinite(v)) || b.x < 0 || b.y < 0 ||
        b.width <= 0 || b.height <= 0) continue;
    words.push({ text, confidence: conf / 100, boundingBox: b,
      lineKey: `${col[idx.block_num]}:${col[idx.par_num]}:${col[idx.line_num]}` });
  }
  if (!Number.isFinite(imageWidth) || imageWidth <= 0 ||
      !Number.isFinite(imageHeight) || imageHeight <= 0)
    throw error("Local OCR TSV lacks image dimensions.", "OCR_INVALID_TSV", 502);
  const blocks = words.filter(w => w.boundingBox.x + w.boundingBox.width <= imageWidth + 1 &&
    w.boundingBox.y + w.boundingBox.height <= imageHeight + 1)
    .map(({text, confidence, boundingBox}) => ({text, confidence, boundingBox}));
  const linesOfText = [];
  let lastLine;
  for (const w of words) {
    if (w.lineKey !== lastLine) { linesOfText.push([]); lastLine = w.lineKey; }
    linesOfText.at(-1).push(w.text);
  }
  const text = linesOfText.map(line => line.join(" ")).join("\n").trim();
  const confidence = blocks.length ? blocks.reduce((s,b)=>s+b.confidence,0)/blocks.length : 0;
  return { text, confidence, width: imageWidth, height: imageHeight, blocks };
}
export async function localOcrHealth(env = process.env, runner = execFile) {
  let config;
  try { config = tesseractConfig(env); } catch {
    return { state: "NOT_CONFIGURED", provider: "local_tesseract", mode: "LOCAL_ONLY", maxFileBytes: MAX_BYTES };
  }
  try {
    const { stdout, stderr } = await runner(config.binary, ["--version"], { timeout: 3000, maxBuffer: 1024 * 1024, windowsHide: true });
    const versionLine = String(stdout || stderr).split(/\r?\n/)[0];
    const match = versionLine.match(/tesseract\s+(\d+\.\d+(?:\.\d+)?)/i);
    if (!match || Number(match[1].split(".")[0]) < 5)
      return { state: "DEGRADED", provider: "local_tesseract", mode: "LOCAL_ONLY", version: match?.[1], maxFileBytes: MAX_BYTES };
    const langs=await runner(config.binary, ["--list-langs"],
      { timeout: 3000, maxBuffer: 1024 * 1024, windowsHide: true });
    const models=String((langs.stdout??"")+"\n"+(langs.stderr??"")).split(/\r?\n/).map(s=>s.trim());
    const english=models.includes("eng");
    return { state: english ? "ONLINE" : "DEGRADED", provider: "local_tesseract", mode: "LOCAL_ONLY",
      version: match[1], modelLoaded: english, language:"eng",
      maxFileBytes: MAX_BYTES, maxConcurrentJobs: 1 };
  } catch {
    return { state: config.configured ? "OFFLINE" : "NOT_CONFIGURED", provider: "local_tesseract",
      mode: "LOCAL_ONLY", maxFileBytes: MAX_BYTES };
  }
}
// Limit CPU-intensive Tesseract processes to one per local server.
let ocrQueue=Promise.resolve();
export async function requestLocalTesseract(file, {env = process.env, runner = execFile} = {}) {
  const previous=ocrQueue;
  let release;
  ocrQueue=new Promise(resolve=>{release=resolve;});
  await previous;
  try {
    return await processLocalPage(file,{env,runner});
  } finally { release(); }
}
async function processLocalPage(file, {env,runner}) {
  const config = tesseractConfig(env);
  if (!(file instanceof File) || !/^image\/(?:jpeg|png)$/i.test(file.type))
    throw error("Local OCR accepts rendered JPEG or PNG pages only.", "OCR_INVALID_INPUT", 415);
  if (!file.size || file.size > MAX_BYTES)
    throw error("Rendered OCR page exceeds the local 8 MB limit.", "OCR_LOCAL_SIZE_LIMIT", 413);
  const directory = await mkdtemp(join(tmpdir(), "brokerdesk-ocr-"));
  try {
    const input = join(directory, file.type === "image/png" ? "page.png" : "page.jpg");
    await writeFile(input, Buffer.from(await file.arrayBuffer()), {flag:"wx", mode:0o600});
    let output;
    try {
      output = await runner(config.binary,
        [input, "stdout", "-l", "eng", "--oem", "1", "--psm", "3", "tsv"],
        { timeout: config.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false });
    } catch (cause) {
      if (cause?.killed || cause?.code === "ETIMEDOUT")
        throw error("Local OCR timed out. Retry this page or review manually.", "OCR_TIMEOUT", 504);
      if (cause?.code === "ENOENT")
        throw error("Tesseract 5 was not found on this computer.", "OCR_NOT_CONFIGURED", 503);
      throw error("Local OCR process failed. Review the page manually.", "OCR_LOCAL_PROCESS_FAILED", 502);
    }
    const page = parseTesseractTsv(output.stdout);
    if (!page.text)
      throw error("Local OCR found no readable text on this page.", "OCR_EMPTY_RESULT", 422);
    return { text: page.text, rawText: page.text, normalizedText: page.text, confidence: page.confidence,
      pages: [{ page:1, pageNumber:1, text:page.text, confidence:page.confidence, blocks:page.blocks,
        width:page.width, height:page.height }],
      metadata: { provider:"local_tesseract", mode:"LOCAL_ONLY", requestSucceeded:true,
        requiresBrokerVerification:true, geometryOrientationVerified:false } };
  } finally {
    await rm(directory, { recursive:true, force:true });
  }
}
