import assert from 'node:assert/strict';
import { test } from 'node:test';
import { context } from './tool-fixture.mjs';
import { createProjectStatusTool, describeProjects } from '../src/mastra/tools/project-status.ts';

const at = '2026-11-24T00:00:00.000Z';
const files = paths => paths.map(path => ({ path, updatedAt: at }));

test('without a project name every project folder is listed, ignoring other files', () => {
  const result = describeProjects(files(['/projects/雨夜/01-创意构思.md', '/projects/长街/03-人物设计.md', '/notes/a.md']));
  assert.deepEqual(result, { projects: ['雨夜', '长街'].sort() });
});

test('a project reports finished stages and what a script still needs', () => {
  const result = describeProjects(
    files(['/projects/雨夜/01-创意构思.md', '/projects/雨夜/03-人物设计.md', '/projects/雨夜/05-互动设计.md']),
    '雨夜',
  );
  assert.equal(result.exists, true);
  assert.equal(result.readyForScript, false);
  assert.deepEqual(result.missingForScript, ['分集大纲']);
  assert.equal(result.stages.find(stage => stage.id === '03').done, true);
  assert.equal(result.nextStage, '世界观设定');
});

test('a project with 01, 03, 05 and 06 is ready for scripting; 00 is optional', () => {
  const result = describeProjects(
    files(['01-创意构思.md', '03-人物设计.md', '05-互动设计.md', '06-分集大纲.md'].map(name => `/projects/雨夜/${name}`)),
    '雨夜',
  );
  assert.equal(result.readyForScript, true);
  assert.deepEqual(result.missingForScript, []);
});

test('an unknown project does not exist and is not ready', () => {
  const result = describeProjects(files(['/projects/雨夜/01-创意构思.md']), '不存在');
  assert.equal(result.exists, false);
  assert.equal(result.readyForScript, false);
});

test('the tool lists files for the calling user only', async () => {
  const owners = [];
  const tool = createProjectStatusTool({
    files: {
      list: async owner => {
        owners.push(owner);
        return files(['/projects/雨夜/01-创意构思.md']);
      },
    },
  });
  const result = await tool.execute(
    { project: '雨夜' },
    { requestContext: context('alice'), agent: { agentId: 'creator-agent', threadId: 't', toolCallId: 'c' } },
  );
  assert.deepEqual(owners, ['alice']);
  assert.equal(result.stages[1].done, true);
  assert.equal(result.ledger, undefined);
});

test('a named project also reports its ledger counts and unrevealed foreshadows', async () => {
  const tool = createProjectStatusTool({
    files: { list: async () => files(['/projects/雨夜/01-创意构思.md']) },
    ledger: {
      read: async (owner, project) => {
        assert.deepEqual([owner, project], ['alice', '雨夜']);
        return [
          { kind: 'character' },
          { kind: 'foreshadow' },
          { kind: 'foreshadow', revealedEpisode: 3 },
        ];
      },
    },
  });
  const agent = { agentId: 'creator-agent', threadId: 't', toolCallId: 'c' };
  const named = await tool.execute({ project: '雨夜' }, { requestContext: context('alice'), agent });
  assert.deepEqual(named.ledger, { counts: { character: 1, foreshadow: 2 }, openForeshadows: 1 });
  const listing = await tool.execute({}, { requestContext: context('alice'), agent });
  assert.equal(listing.ledger, undefined);
});
