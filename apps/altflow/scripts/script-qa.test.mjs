import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScriptReviewer } from '../src/mastra/agents/script-reviewer.ts';
import { createScriptQaWorkflow, REVIEW_DIMENSIONS } from '../src/mastra/workflows/script-qa.ts';
import { context, modelServer } from './tool-fixture.mjs';

const valid = `第1集 雨夜来客
1-1 老宅门口（夜）
△雨声里，门被敲响。
林川：谁？
1-1-互动 门外的人说是旧识，开不开门？
1-1-A：隔着门问清来意 → 1-2-A
1-1-B：直接拉开门 → 1-2-B
1-2-A 门内
林川：你先说名字。
（合流 → 1-3）
1-2-B 门口
△来人一把按住门框。
（合流 → 1-3）
1-3 堂屋（夜）
△两人对坐，茶已凉。
本集结束
`;

async function run(script, review) {
  const workflow = createScriptQaWorkflow(review);
  const result = await (await workflow.createRun()).start({ inputData: { script, coreExperience: '信任与试探' } });
  assert.equal(result.status, 'success');
  return result.result;
}

test('every review dimension runs once with the script and core experience', async () => {
  const seen = [];
  const output = await run(valid, async input => {
    seen.push(input);
    return [];
  });
  assert.deepEqual(
    seen.map(item => item.dimension.id).sort(),
    REVIEW_DIMENSIONS.filter(item => item.id !== 'principles')
      .map(item => item.id)
      .sort(),
  );
  assert.ok(seen.every(item => item.script === valid && item.coreExperience === '信任与试探'));
  assert.equal(output.passed, true);
  assert.equal(output.errors, 0);
  assert.match(output.report, /^# 质量检查报告/);
  assert.match(output.report, /结论：通过/);
});

test('model findings and structural findings both land in the report', async () => {
  const broken = valid.replace('（合流 → 1-3）\n1-2-B', '\n1-2-B');
  const output = await run(broken, async ({ dimension }) =>
    dimension.id === 'consistency'
      ? [{ severity: 'error', location: '1-2-A', problem: '林川提前知道来人身份', suggestion: '删掉这句台词' }]
      : [{ severity: 'warn', location: '1-3', problem: '收束偏弱', suggestion: '补一个动作' }],
  );
  assert.equal(output.passed, false);
  assert.ok(output.errors >= 2);
  assert.equal(output.warnings, 3);
  assert.match(output.report, /\[死路\]/);
  assert.match(output.report, /1-2-A：林川提前知道来人身份 建议：删掉这句台词/);
  assert.match(output.report, /结论：未通过/);
});

test('the reviewer is a standalone agent that resolves its model lazily', async t => {
  const edge = await modelServer(t);
  edge.responses.push({
    text: JSON.stringify({ issues: [{ severity: 'warn', location: '1-3', problem: '收束偏弱', suggestion: '补一个动作' }] }),
  });
  let resolved = 0;
  const { review } = createScriptReviewer(async () => {
    resolved += 1;
    return edge.model;
  });
  const issues = await review({ dimension: REVIEW_DIMENSIONS[3], script: valid });
  assert.ok(resolved >= 1);
  assert.deepEqual(
    issues.map(issue => issue.location),
    ['1-3'],
  );
});

const twoEpisodes = `${valid}第2集 暗线
2-1 书房（晨）
林川：账本呢？
本集结束
`;

const ledgerEntries = [
  { kind: 'character', key: '林川', episode: 1, content: '死于雨夜', status: 'dead', revision: 1, updatedAt: '' },
  { kind: 'foreshadow', key: '账本', episode: 1, content: '缺页', plannedRevealEpisode: 2, revision: 1, updatedAt: '' },
  { kind: 'foreshadow', key: '雨声', episode: 1, content: '重复的雨声', revealedEpisode: 2, revision: 1, updatedAt: '' },
];

async function runWithLedger(script, ledger, extra = { project: '雨夜' }) {
  const workflow = createScriptQaWorkflow(async () => [], ledger);
  const result = await (await workflow.createRun()).start({
    inputData: { script, ...extra },
    requestContext: context('alice'),
  });
  assert.equal(result.status, 'success');
  return result.result;
}

test('the ledger of the calling user is checked for dead characters and overdue foreshadowing', async () => {
  const owners = [];
  const output = await runWithLedger(twoEpisodes, {
    read: async (owner, project) => {
      owners.push([owner, project]);
      return ledgerEntries;
    },
  });
  assert.deepEqual(owners, [['alice', '雨夜']]);
  assert.equal(output.passed, false);
  assert.match(output.report, /\[角色状态矛盾\] 角色「林川」在第 1 集已死亡，但场景 2-1 中仍有他的台词/);
  assert.match(output.report, /\[伏笔未回收\] 伏笔「账本」/);
  assert.doesNotMatch(output.report, /伏笔「雨声」/);
});

test('an empty ledger is reported, and no project means no ledger lookup', async () => {
  const empty = await runWithLedger(valid, { read: async () => [] });
  assert.match(empty.report, /台账还是空的/);
  let reads = 0;
  const skipped = await runWithLedger(
    valid,
    {
      read: async () => {
        reads += 1;
        return ledgerEntries;
      },
    },
    {},
  );
  assert.equal(reads, 0);
  assert.doesNotMatch(skipped.report, /台账/);
});

test('creative principles are reviewed only when given, and the reviewer sees them', async () => {
  const principles = ['每个互动选择必须带来可见后果', '禁止现代用语出现在古代角色口中'];
  const seen = [];
  const workflow = createScriptQaWorkflow(async input => {
    seen.push(input);
    return input.dimension.id === 'principles'
      ? [{ severity: 'error', location: '1-2-A', problem: '违反第 2 条', suggestion: '改用古语' }]
      : [];
  });
  const given = await (await workflow.createRun()).start({ inputData: { script: valid, principles } });
  assert.equal(given.status, 'success');
  assert.deepEqual(seen.find(item => item.dimension.id === 'principles').principles, principles);
  assert.match(given.result.report, /## 模型审查：创作原则对照\n- 错误 1-2-A：违反第 2 条/);

  seen.length = 0;
  const without = await (await workflow.createRun()).start({ inputData: { script: valid } });
  assert.equal(
    seen.some(item => item.dimension.id === 'principles'),
    false,
  );
  assert.match(without.result.report, /未提供创作原则，已跳过/);
});

test('state problems in the script reach the report when variables are given', async () => {
  const withState = valid.replace('林川：你先说名字。', '（状态：SV_trust+10；FLAG_secret=真）\n林川：你先说名字。');
  const workflow = createScriptQaWorkflow(async () => []);
  const result = await (await workflow.createRun()).start({
    inputData: { script: withState, variables: [{ name: 'SV_trust', initial: 50 }] },
  });
  assert.match(result.result.report, /\[状态未定义\] FLAG_secret/);
});
