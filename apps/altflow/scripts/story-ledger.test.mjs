import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ledgerSaveEntrySchema, StoryLedgerStore } from '../src/mastra/services/story-ledger.ts';
import { createScriptGraphTool } from '../src/mastra/tools/script-graph.ts';
import { createStoryLedgerTools } from '../src/mastra/tools/story-ledger.ts';
import { context } from './tool-fixture.mjs';

async function ledger(t) {
  const dir = await mkdtemp(join(tmpdir(), 'altflow-ledger-'));
  const store = new StoryLedgerStore(`file:${join(dir, 'ledger.db')}`);
  await store.init();
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return store;
}

const entry = (over = {}) => ({
  kind: 'character',
  key: '林川',
  episode: 1,
  content: '在世，持有账本',
  revision: 0,
  ...over,
});

test('entries are saved, read back with their revision, and corrected in place', async t => {
  const store = await ledger(t);
  await store.apply('alice', '雨夜', {
    upserts: [entry(), entry({ kind: 'foreshadow', key: '账本', content: '账本缺了一页' })],
  });
  const first = await store.read('alice', '雨夜');
  assert.deepEqual(
    first.map(item => [item.kind, item.key, item.revision]),
    [
      ['character', '林川', 1],
      ['foreshadow', '账本', 1],
    ],
  );
  await store.apply('alice', '雨夜', {
    upserts: [entry({ episode: 2, status: 'dead', content: '死于雨夜', revision: 1 })],
  });
  const [character] = await store.read('alice', '雨夜', 'character');
  assert.equal(character.revision, 2);
  assert.equal(character.status, 'dead');
});

test('a stale revision is rejected and a batch is all or nothing', async t => {
  const store = await ledger(t);
  await store.apply('alice', '雨夜', { upserts: [entry()] });
  await assert.rejects(
    store.apply('alice', '雨夜', {
      upserts: [entry({ key: '新人物', content: '新增' }), entry({ content: '改动', revision: 0 })],
    }),
    /已被更新/,
  );
  assert.deepEqual(
    (await store.read('alice', '雨夜')).map(item => item.key),
    ['林川'],
  );
});

test('ledgers are separate per user and per project', async t => {
  const store = await ledger(t);
  await store.apply('alice', '雨夜', { upserts: [entry()] });
  assert.deepEqual(await store.read('bob', '雨夜'), []);
  assert.deepEqual(await store.read('alice', '长街'), []);
});

test('removal needs the current revision and the ledger size is capped', async t => {
  const store = await ledger(t);
  await store.apply('alice', '雨夜', { upserts: [entry()] });
  await assert.rejects(
    store.apply('alice', '雨夜', { removals: [{ kind: 'character', key: '林川', revision: 5 }] }),
    /不存在或已被更新/,
  );
  await store.apply('alice', '雨夜', { removals: [{ kind: 'character', key: '林川', revision: 1 }] });
  assert.deepEqual(await store.read('alice', '雨夜'), []);
  for (let batch = 0; batch < 7; batch += 1)
    await store.apply('alice', '大剧', {
      upserts: Array.from({ length: 28 }, (_, i) => entry({ kind: 'fact', key: `设定${batch}-${i}` })),
    });
  await assert.rejects(
    store.apply('alice', '大剧', {
      upserts: Array.from({ length: 5 }, (_, i) => entry({ kind: 'fact', key: `多出${i}` })),
    }),
    /最多 200 条/,
  );
  assert.equal((await store.read('alice', '大剧')).length, 196);
});

test('the schema rejects fields that do not belong to the kind and impossible episodes', () => {
  assert.equal(ledgerSaveEntrySchema.safeParse(entry({ kind: 'fact', status: 'dead' })).success, false);
  assert.equal(ledgerSaveEntrySchema.safeParse(entry({ kind: 'fact', revealedEpisode: 3 })).success, false);
  assert.equal(
    ledgerSaveEntrySchema.safeParse(entry({ kind: 'foreshadow', episode: 4, revealedEpisode: 2 })).success,
    false,
  );
  assert.equal(
    ledgerSaveEntrySchema.safeParse(entry({ kind: 'foreshadow', episode: 2, revealedEpisode: 5 })).success,
    true,
  );
});

test('the tools use the authenticated user and list unrevealed foreshadows', async t => {
  const store = await ledger(t);
  const tools = createStoryLedgerTools({ store });
  const run = (tool, input, user) =>
    tool.execute(input, {
      requestContext: context(user),
      agent: { agentId: 'creator-agent', threadId: 't', toolCallId: 'c' },
    });
  await run(
    tools.story_ledger_save,
    {
      project: '雨夜',
      entries: [
        entry({ kind: 'foreshadow', key: '账本', content: '缺页', plannedRevealEpisode: 6 }),
        entry({ kind: 'foreshadow', key: '雨声', content: '重复的雨声', revealedEpisode: 2 }),
      ],
    },
    'alice',
  );
  const read = await run(tools.story_ledger_read, { project: '雨夜' }, 'alice');
  assert.deepEqual(read.openForeshadows, [{ key: '账本', plantedEpisode: 1, plannedRevealEpisode: 6 }]);
  const other = await run(tools.story_ledger_read, { project: '雨夜' }, 'bob');
  assert.deepEqual(other.entries, []);
});

test('analyze_script_graph reports graph problems without a model', async () => {
  const script = `第1集 雨夜
1-1 门口（夜）
△敲门。
1-1-互动 开门吗？
1-1-A：开 → 1-2-A
1-1-B：不开 → 1-2-A
1-2-A 门内
△风。
本集结束
`;
  const result = await createScriptGraphTool().execute({ script }, {});
  assert.ok(result.issues.some(issue => issue.rule === '虚假自由'));
  assert.equal(result.stats.endings, 1);
});
