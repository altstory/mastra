import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScriptReviewer } from '../src/mastra/agents/script-reviewer.ts';
import { createScriptQaWorkflow, REVIEW_DIMENSIONS } from '../src/mastra/workflows/script-qa.ts';
import { modelServer } from './tool-fixture.mjs';

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
  assert.deepEqual(seen.map(item => item.dimension.id).sort(), REVIEW_DIMENSIONS.map(item => item.id).sort());
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
