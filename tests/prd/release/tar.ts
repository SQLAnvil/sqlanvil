// A small tar reader for the package tarballs (testing.md, Harness: a test reads a tarball's
// entries with a tar library, never with macOS `tar tzf`). It reports every entry the archive
// holds, `._*` AppleDouble entries included; pax ("x", "g") and GNU long-name ("L", "K")
// records are metadata for the next entry, not entries of their own.

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

export interface TarEntry {
  name: string;
  /** The ustar typeflag: "0" regular file, "5" directory, "2" symlink, ... (NUL is "0"). */
  type: string;
  data: Buffer;
}

function field(header: Buffer, start: number, length: number): string {
  const b = header.subarray(start, start + length);
  const nul = b.indexOf(0);
  return b.subarray(0, nul < 0 ? length : nul).toString("utf8");
}

function paxRecords(data: Buffer): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) {
      break;
    }
    const len = parseInt(data.subarray(off, space).toString("utf8"), 10);
    if (!(len > 0)) {
      break;
    }
    const record = data.subarray(space + 1, off + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) {
      out[record.substring(0, eq)] = record.substring(eq + 1);
    }
    off += len;
  }
  return out;
}

export function readTarGz(file: string): TarEntry[] {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  const entries: TarEntry[] = [];
  let off = 0;
  let nextName: string | undefined;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) {
      break;
    }
    let name = field(header, 0, 100);
    const size = parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const magic = field(header, 257, 6);
    if (magic.startsWith("ustar")) {
      const prefix = field(header, 345, 155);
      if (prefix) {
        name = `${prefix}/${name}`;
      }
    }
    const data = Buffer.from(buf.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const records = paxRecords(data);
      if (records.path !== undefined) {
        nextName = records.path;
      }
      continue;
    }
    if (type === "g" || type === "K") {
      continue;
    }
    if (type === "L") {
      nextName = field(data, 0, data.length);
      continue;
    }
    if (nextName !== undefined) {
      name = nextName;
      nextName = undefined;
    }
    entries.push({ name, type, data });
  }
  return entries;
}

export function entry(entries: TarEntry[], name: string): TarEntry {
  const found = entries.find((e) => e.name === name);
  if (!found) {
    throw new Error(`the archive has no entry ${name}`);
  }
  return found;
}

/** Writes every regular-file entry of the archive under `dest`, keeping its path. */
export function extractTarGz(file: string, dest: string) {
  for (const e of readTarGz(file)) {
    if (e.type !== "0" || e.name.endsWith("/")) {
      continue;
    }
    const out = path.join(dest, e.name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, e.data);
  }
}

export function manifest(file: string): any {
  return JSON.parse(entry(readTarGz(file), "package/package.json").data.toString("utf8"));
}

export const CLI_TAR = "packages/@sqlanvil/cli/package.tar.gz";
export const CORE_TAR = "packages/@sqlanvil/core/package.tar.gz";
export const SAMPLE_TAR = "packages/sample-extension/package.tar.gz";
