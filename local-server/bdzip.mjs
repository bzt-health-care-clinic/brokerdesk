import { inflateRawSync } from "node:zlib";

/** Tight pilot limits: failures are explicit instead of silently dropping PDFs. */
export const BDZIP_MAX_BYTES = 50 * 1024 * 1024;
export const BDZIP_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const BDZIP_MAX_ENTRIES = 80;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const crcTable = Uint32Array.from({length: 256}, (_, i) => {
  let c = i;
  for (let n = 0; n < 8; n++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function verifyName(name) {
  if (!name || name.length > 220 || name.includes("\\") || name.startsWith("/") ||
    name.startsWith("./") || /[\u0000-\u001f:]/.test(name) ||
    name.split("/").some(part => !part || part === "." || part === "..")) throw fail("Unsafe ZIP entry path.");
  if (!/^(?:manifest\.json|case\.json|document-records\.json|reviewed-keyin\.json|documents\/[A-Za-z0-9_.()-]{1,180})$/.test(name))
    throw fail(`Unexpected ZIP entry path: ${name.slice(0,80)}`);
}
export function createBdzip(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > BDZIP_MAX_ENTRIES)
    throw fail("Invalid package file count.");
  const seen = new Set(), locals = [], centrals = []; let offset = 0, total = 0;
  for (const entry of entries) {
    const name = String(entry.path ?? ""); verifyName(name);
    const key = name.toLowerCase();
    if (seen.has(key)) throw fail(`Duplicate ZIP filename: ${name}`);
    seen.add(key);
    const nameBytes = Buffer.from(name, "utf8"), bytes = Buffer.from(entry.bytes);
    if (bytes.length > BDZIP_MAX_FILE_BYTES) throw fail("A source file exceeds the pilot limit.", 413);
    total += bytes.length;
    if (total > BDZIP_MAX_BYTES) throw fail("Total source files exceed the pilot package limit.", 413);
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + bytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
export function readBdzip(input) {
  const bytes = Buffer.from(input);
  if (bytes.length > BDZIP_MAX_BYTES || bytes.length < 22) throw fail("Invalid or oversized BDZIP.", 413);
  // Find EOCD within the maximum allowed ZIP comment window.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw fail("ZIP central directory missing.");
  const count = bytes.readUInt16LE(end + 10), countDisk = bytes.readUInt16LE(end + 8);
  const centralSize = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16);
  if (!count || count !== countDisk || count > BDZIP_MAX_ENTRIES || bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 || centralStart + centralSize > end)
    throw fail("ZIP directory is invalid, multi-disk, or exceeds pilot limits.");
  const found = new Map(), seen = new Set(), ranges = []; let cursor = centralStart, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw fail("Malformed ZIP directory entry.");
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20);
    const plain = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    if (flags & 1 || (flags & ~0x0808) !== 0 || ![0, 8].includes(method) ||
      compressed === 0xffffffff || plain === 0xffffffff || offset === 0xffffffff)
      throw fail("Encrypted or unsupported ZIP entry.");
    if (plain > BDZIP_MAX_FILE_BYTES || total + plain > BDZIP_MAX_BYTES) throw fail("ZIP expanded size exceeds limit.", 413);
    if (compressed > bytes.length || (compressed > 0 && plain > compressed * 100)) throw fail("ZIP expansion ratio exceeds limit.", 413);
    const nameStart = cursor + 46, nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > centralStart + centralSize) throw fail("Malformed ZIP name.");
    const name = bytes.toString("utf8", nameStart, nameEnd);
    verifyName(name);
    if (seen.has(name.toLowerCase())) throw fail("Duplicate ZIP path.");
    seen.add(name.toLowerCase());
    if (offset + 30 > centralStart || bytes.readUInt32LE(offset) !== 0x04034b50)
      throw fail("Invalid local ZIP header.");
    const localNameLength = bytes.readUInt16LE(offset + 26), localExtraLength = bytes.readUInt16LE(offset + 28);
    const localName = bytes.toString("utf8", offset + 30, offset + 30 + localNameLength);
    if (name !== localName || bytes.readUInt16LE(offset + 8) !== method) throw fail("ZIP headers disagree.");
    const bodyOffset = offset + 30 + localNameLength + localExtraLength;
    if (bodyOffset + compressed > centralStart) throw fail("Overlapping or invalid ZIP entry.");
    ranges.push([offset, bodyOffset + compressed]);
    let decoded;
    try {
      decoded = method === 0 ? bytes.subarray(bodyOffset, bodyOffset + compressed)
        : inflateRawSync(bytes.subarray(bodyOffset, bodyOffset + compressed), { maxOutputLength: plain + 1 });
    } catch { throw fail(`Cannot decompress ${name}`); }
    if (decoded.length !== plain || crc32(decoded) !== crc) throw fail(`CRC or size mismatch: ${name}`);
    found.set(name, Buffer.from(decoded)); total += plain;
    cursor = nameEnd + extraLength + commentLength;
  }
  if (cursor !== centralStart + centralSize) throw fail("Unexpected central directory bytes.");
  ranges.sort((a,b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i-1][1]) throw fail("Overlapping ZIP entries.");
  return found;
}
