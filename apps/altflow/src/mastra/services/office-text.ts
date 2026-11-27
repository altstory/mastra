import { inflateRawSync } from 'node:zlib';

const MAX_ENTRIES = 10_000;
const MAX_XML_BYTES = 250 * 1024 * 1024;
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function readEntry(zip: Buffer, wanted: string): Buffer | undefined {
  const searchFrom = Math.max(0, zip.length - 65_557);
  let eocd = -1;
  for (let at = zip.length - 22; at >= searchFrom; at--) {
    if (zip.readUInt32LE(at) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const total = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);
  if (total === 0xffff || cursor === 0xffffffff) throw new Error('zip64 archives are not supported');
  for (let index = 0; index < Math.min(total, MAX_ENTRIES); index++) {
    if (zip.readUInt32LE(cursor) !== CENTRAL) throw new Error('corrupt zip directory');
    const method = zip.readUInt16LE(cursor + 10);
    const compressed = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const local = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name !== wanted) continue;
    if (size > MAX_XML_BYTES) throw new Error('document body is too large');
    if (zip.readUInt32LE(local) !== LOCAL) throw new Error('corrupt zip entry');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
    throw new Error('unsupported zip compression');
  }
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (value: string) =>
  value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_, hex, dec, name) =>
    name ? entities[name.toLowerCase()] : String.fromCodePoint(Number.parseInt(hex ?? dec, hex ? 16 : 10)),
  );

function wordText(xml: string) {
  const token =
    /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>|<w:noBreakHyphen\b[^>]*\/>|<\/w:p>/g;
  let text = '';
  for (const match of xml.matchAll(token)) {
    const tag = match[0];
    if (match[1] !== undefined) text += decode(match[1]);
    else if (tag.startsWith('<w:tab')) text += '\t';
    else if (tag.startsWith('<w:noBreakHyphen')) text += '-';
    else text += '\n';
  }
  return text;
}

function openDocumentText(xml: string) {
  let text = '';
  let inside = 0;
  for (const match of xml.matchAll(/<[^>]*>|[^<]+/g)) {
    const tag = match[0];
    if (!tag.startsWith('<')) {
      if (inside > 0) text += decode(tag);
    } else if (/^<text:(?:p|h)(?:\s[^>]*)?\/>$/.test(tag)) text += '\n';
    else if (/^<text:(?:p|h)(?:\s[^>]*)?>$/.test(tag)) inside++;
    else if (/^<\/text:(?:p|h)>$/.test(tag)) {
      if (inside > 0) inside--;
      text += '\n';
    } else if (/^<text:tab(?:\s[^>]*)?\/>$/.test(tag)) text += '\t';
    else if (/^<text:line-break(?:\s[^>]*)?\/>$/.test(tag)) text += '\n';
    else {
      const space = /^<text:s(?:\s+text:c="(\d+)")?\s*\/>$/.exec(tag);
      if (space) text += ' '.repeat(Number(space[1] ?? 1));
    }
  }
  return text;
}

/** Reads the flowing text of a DOCX or ODT straight from its XML. It does not need a layout engine, so it needs no fonts.
 * Throws when the file is not a readable archive; callers fall back to the conversion engine.
 */
export function extractDocumentText(bytes: Buffer, extension: string): string {
  const docx = extension === '.docx';
  const entry = readEntry(bytes, docx ? 'word/document.xml' : 'content.xml');
  if (!entry) throw new Error('document body not found');
  const xml = entry.toString('utf8').replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  return (docx ? wordText(xml) : openDocumentText(xml)).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}
