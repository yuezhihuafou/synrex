import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXTENSION_FILES = [
  "manifest.json",
  "background.js",
  "content.js",
  "popup.html",
  "popup.js",
  "README.md",
] as const;

let crcTable: Uint32Array | undefined;
function table(): Uint32Array {
  if (crcTable) return crcTable;
  const values = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    values[i] = c >>> 0;
  }
  crcTable = values;
  return values;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  const values = table();
  for (const byte of data) crc = values[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name: Buffer, data: Buffer): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(0, 10);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, data]);
}

function centralHeader(name: Buffer, data: Buffer, offset: number): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(crc32(data), 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

export function browserExtensionDirectory(): string {
  return fileURLToPath(new URL("../deploy/observability/browser-extension/", import.meta.url));
}

/** Build a small STORE-only ZIP from the audited extension allowlist. */
export function buildBrowserExtensionZip(directory = browserExtensionDirectory()): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of EXTENSION_FILES) {
    const data = readFileSync(path.join(directory, file));
    const name = Buffer.from(file, "utf8");
    const local = localHeader(name, data);
    locals.push(local);
    central.push(centralHeader(name, data, offset));
    offset += local.length;
  }
  const centralBody = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(EXTENSION_FILES.length, 8);
  end.writeUInt16LE(EXTENSION_FILES.length, 10);
  end.writeUInt32LE(centralBody.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBody, end]);
}
