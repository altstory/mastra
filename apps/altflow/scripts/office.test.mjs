import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConverter } from '@deepseek-ai/libreoffice-kit';
import { test } from 'node:test';
import { Agent } from '@mastra/core/agent';
import { Workspace } from '@mastra/core/workspace';
import { OfficeReader } from '../src/mastra/services/office.ts';
import { createDocumentTools } from '../src/mastra/tools/read-document.ts';
import { UserFilesystem } from '../src/mastra/user-filesystem.ts';
import { setup } from './storage-fixture.mjs';
import { context, modelServer, toolResults } from './tool-fixture.mjs';

for (const extension of ['docx', 'xlsx', 'pptx']) {
  test(`DSH Office engine reads a real ${extension} from private storage without changing it`, async t => {
    const { store } = await setup(t);
    const bytes = await readFile(new URL(`./fixtures/office/body.${extension}`, import.meta.url));
    const path = `/uploads/body.${extension}`;
    await store.write('alice', path, bytes);
    const reader = new OfficeReader(store);
    const text = await reader.read('alice', path);
    assert.match(text, /Office/);
    if (extension !== 'xlsx') assert.match(text, /松树边的蓝色风筝/);
    assert.deepEqual(await store.read('alice', path), bytes);
    await assert.rejects(reader.read('bob', path), /不存在/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(reader.read('alice', path, controller.signal), /abort/i);
  });
}

test('corrupt Office input returns a parsing error instead of raw ZIP bytes', async t => {
  const { store } = await setup(t);
  await store.write('alice', '/bad.docx', Buffer.from('not a document'));
  await assert.rejects(new OfficeReader(store).read('alice', '/bad.docx'));
});

test('the real Agent read_file tool routes Office text reads through DSH and keeps binary reads intact', async t => {
  const { store } = await setup(t);
  const bytes = await readFile(new URL('./fixtures/office/body.docx', import.meta.url));
  await store.write('alice', '/uploads/body.docx', bytes);
  const documents = createDocumentTools(new OfficeReader(store));
  const edge = await modelServer(t);
  edge.responses.push(
    { calls: [{ name: 'mastra_workspace_read_file', args: { path: '/uploads/body.docx' } }] },
    { text: 'Read complete.' },
  );
  const agent = new Agent({
    id: 'reader',
    name: 'Reader',
    model: edge.model,
    instructions: 'Read the file.',
    tools: documents.tools,
    workspace: new Workspace({ filesystem: new UserFilesystem(store, 'alice') }),
    inputProcessors: [documents.processor],
  });
  const result = await agent.generate('Read my document.', { requestContext: context('alice'), maxSteps: 3 });
  assert.match(JSON.stringify(toolResults(result)), /松树边的蓝色风筝/);
  assert.doesNotMatch(JSON.stringify(toolResults(result)), /binary file not readable/);
  assert.deepEqual(await new UserFilesystem(store, 'alice').readFile('/uploads/body.docx'), bytes);
});

test('PDF body text uses the same authenticated storage', async t => {
  const { store } = await setup(t);
  const dir = await mkdtemp(join(tmpdir(), 'office-pdf-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.docx'),
    output = join(dir, 'body.pdf');
  await writeFile(input, await readFile(new URL('./fixtures/office/body.docx', import.meta.url)));
  const converter = await createConverter();
  try {
    await converter.render({ inputPath: input, outputPath: output });
  } finally {
    await converter.dispose();
  }
  await store.write('alice', '/body.pdf', await readFile(output));
  assert.match(await new OfficeReader(store).read('alice', '/body.pdf'), /松树边的蓝色风筝/);
});

test('DSH converts real Office files, renders a page to PNG and recalculates a workbook', async t => {
  const { store } = await setup(t);
  const word = await readFile(new URL('./fixtures/office/body.docx', import.meta.url));
  const workbook = await readFile(new URL('./fixtures/office/body.xlsx', import.meta.url));
  await store.write('alice', '/body.docx', word);
  await store.write('alice', '/body.xlsx', workbook);
  const reader = new OfficeReader(store);
  const converted = await reader.produce('alice', '/body.docx', 'convert', { format: 'pdf' });
  assert.equal(converted.files[0].mimeType, 'application/pdf');
  assert.equal((await store.read('alice', converted.files[0].path)).subarray(0, 4).toString(), '%PDF');
  const rendered = await reader.produce('alice', '/body.docx', 'render', { pages: [1] });
  assert.equal(rendered.files.length, 1);
  assert.deepEqual(
    (await store.read('alice', rendered.files[0].path)).subarray(0, 8),
    Buffer.from('89504e470d0a1a0a', 'hex'),
  );
  const recalculated = await reader.produce('alice', '/body.xlsx', 'recalculate', {});
  assert.match(recalculated.files[0].name, /recalculated\.xlsx$/);
  assert.match(await reader.read('alice', recalculated.files[0].path), /Office/);
  assert.deepEqual(await store.read('alice', '/body.xlsx'), workbook);
  await assert.rejects(reader.produce('bob', '/body.docx', 'convert', { format: 'pdf' }), /不存在/);
});

test('a GBK upload can be read and searched by the Agent without converting the original', async t => {
  const { store } = await setup(t);
  const path = '/uploads/novel-gbk.txt';
  const bytes = Buffer.from('b5dad2bbd5c20d0ad3ead2b9c0b4bfcd0d0ab1bebcafbde1caf8', 'hex');
  await store.write('alice', path, bytes, { source: 'upload' });
  const documents = createDocumentTools(new OfficeReader(store));
  const filesystem = new UserFilesystem(store, 'alice');
  const edge = await modelServer(t);
  edge.responses.push(
    { calls: [{ name: 'mastra_workspace_read_file', args: { path, offset: 2, limit: 1 } }] },
    { calls: [{ name: 'mastra_workspace_grep', args: { path, pattern: '雨夜来客' } }] },
    { calls: [{ name: 'read_document', args: { path, offset: 3, limit: 1 } }] },
    { text: 'Read complete.' },
  );
  const agent = new Agent({
    id: 'gbk-reader',
    name: 'Reader',
    model: edge.model,
    instructions: 'Read and search the uploaded novel.',
    tools: documents.tools,
    workspace: new Workspace({ filesystem }),
    inputProcessors: [documents.processor],
  });
  const result = await agent.generate('Read and search my novel.', {
    requestContext: context('alice'),
    maxSteps: 4,
  });
  const [read, search, document] = toolResults(result);
  assert.match(JSON.stringify(read), /雨夜来客/);
  assert.match(JSON.stringify(search), /雨夜来客/);
  assert.doesNotMatch(JSON.stringify(search), /No matches found/);
  assert.match(JSON.stringify(document), /本集结束/);
  assert.deepEqual(await filesystem.readFile(path), bytes);
  assert.equal(await filesystem.readFile(path, { encoding: 'base64' }), bytes.toString('base64'));
});

test('read_document reads uploaded plain text in pages without invoking Office or crossing accounts', async t => {
  const { store } = await setup(t);
  const path = '/uploads/novel.txt';
  const text = '第一章\n雨夜来客\n本集结束';
  await store.write('alice', path, Buffer.from(text));
  const reader = new OfficeReader(store);
  const tool = createDocumentTools(reader).tools.read_document;
  const result = await tool.execute(
    { path, offset: 2, limit: 1 },
    { requestContext: context('alice'), agent: { agentId: 'reader', threadId: 'test-reader' } },
  );
  assert.equal(result.text, '雨夜来客');
  assert.equal(result.nextOffset, 3);
  assert.equal(result.totalLines, 3);
  await assert.rejects(reader.read('bob', path), /不存在/);
  assert.equal((await store.read('alice', path)).toString(), text);
});
