import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createScriptQaWorkflow } from '../src/mastra/workflows/script-qa.ts';
import { context, modelServer } from './tool-fixture.mjs';

const script = `第1集 雨夜来客
1-1 老宅门口（夜）
△雨声里，门被敲响。
1-1-互动 开不开门？
1-1-A：问清来意 → 1-2-A
1-1-B：直接开门 → 1-2-B
1-2-A 门内
（合流 → 1-3）
1-2-B 门口
（合流 → 1-3）
1-3 堂屋（夜）
△茶已凉。
本集结束
`;

test('the workflow tool result carries the structured report the UI draws', async t => {
  const edge = await modelServer(t);
  const scriptQa = createScriptQaWorkflow(async () => []);
  const agent = new Agent({
    id: 'qa-agent',
    name: 'QA',
    instructions: 'Run the quality check.',
    model: edge.model,
    workflows: { scriptQa },
  });
  new Mastra({ agents: { agent }, workflows: { scriptQa }, logger: false });
  edge.responses.push({ calls: [{ name: 'workflow-scriptQa', args: { inputData: { script } } }] });
  edge.responses.push({ text: '已检查。' });
  const result = await agent.generate('检查剧本', { requestContext: context('alice') });
  const call = result.steps.flatMap(step => step.toolResults ?? [])[0];
  assert.equal(call.payload.toolName, 'workflow-scriptQa');
  const report = call.payload.result.result;
  assert.equal(report.passed, true);
  assert.equal(report.stats.scenes, 4);
  assert.equal(report.sections[0].title, '结构检查');
  assert.deepEqual(
    report.sections.map(section => section.skipped),
    [false, false, false, false, false, true],
  );
  assert.match(report.report, /^# 质量检查报告/);
});
