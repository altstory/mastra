import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { extractDocumentText } from '../src/mastra/services/office-text.ts';

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('a real DOCX is read without the conversion engine', async () => {
  const bytes = await readFile(new URL('./fixtures/office/body.docx', import.meta.url));
  const text = extractDocumentText(bytes, '.docx');
  assert.match(text, /Office/);
  assert.match(text, /松树边的蓝色风筝/);
});

test('DOCX text keeps paragraphs, tabs and breaks, and drops deleted and duplicated text', () => {
  const body =
    '<w:document><w:body>' +
    '<w:p><w:r><w:t>第一段 &amp; 引号&#x4E2D;</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t xml:space="preserve"> 之后</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>换行前</w:t><w:br/><w:t>换行后</w:t></w:r><w:del><w:r><w:delText>已删除</w:delText></w:r></w:del></w:p>' +
    '<mc:AlternateContent><mc:Choice><w:p><w:r><w:t>文本框</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>文本框</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>' +
    '</w:body></w:document>';
  const text = extractDocumentText(zip({ 'word/document.xml': body }), '.docx');
  assert.equal(text, '第一段 & 引号中\t 之后\n换行前\n换行后\n文本框\n');
});

test('ODT text keeps headings, spans, spaces and line breaks', () => {
  const body =
    '<office:document-content><office:automatic-styles><style:style/></office:automatic-styles><office:body><office:text>' +
    '<text:h text:outline-level="1">标题</text:h>' +
    '<text:p>甲<text:span text:style-name="T1">乙</text:span><text:s text:c="3"/>丙<text:line-break/>丁<text:tab/>戊</text:p>' +
    '</office:text></office:body></office:document-content>';
  const text = extractDocumentText(zip({ 'content.xml': body }), '.odt');
  assert.equal(text, '标题\n甲乙   丙\n丁\t戊\n');
});

test('files that are not readable archives throw so the caller can fall back', () => {
  assert.throws(() => extractDocumentText(Buffer.from('not a document'), '.docx'));
  assert.throws(() => extractDocumentText(zip({ 'other.xml': '<x/>' }), '.docx'), /not found/);
});
