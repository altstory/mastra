import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBranchGraph } from '../src/mastra/tools/branch-graph.ts';
import { fixture, runOptions, toolResults } from './tool-fixture.mjs';

const script = `第1集 雨夜来客
1-1 老宅门口（夜）
△雨声里，门被敲响。
林川：谁？
1-1-互动 门外的人说是旧识，开不开门？
1-1-A：隔着门问清来意 → 1-2-A
1-1-B：直接拉开门 → 1-2-B
1-2-A 门内
（状态：SV_trust+10）
林川：你先说名字。
（合流 → 1-3）
1-2-B 门口
△来人一把按住门框。
（合流 → 1-3）
1-3 堂屋（夜）
△两人对坐，茶已凉。
1-3-互动 接下来怎么办？
1-3-A：留他过夜 → 1-4-A
1-3-B：送他出门 → 1-4-B
1-4-A 客房
（结局：同屋共眠）
1-4-B 门口
（闭合）
本集结束
`;

test('scenes become nodes with kinds, titles, options and labelled edges', () => {
  const { nodes, edges, stats } = buildBranchGraph(script);
  const kind = id => nodes.find(node => node.id === id).kind;
  assert.equal(kind('1-1'), 'interaction');
  assert.equal(kind('1-2-A'), 'story');
  assert.equal(kind('1-3'), 'interaction');
  assert.equal(kind('1-4-A'), 'ending');
  assert.equal(nodes.find(node => node.id === '1-4-A').title, '同屋共眠');
  assert.equal(nodes.find(node => node.id === '1-1').title, '老宅门口（夜）');
  assert.deepEqual(
    nodes.find(node => node.id === '1-1').options.map(option => [option.id, option.label, option.toNode]),
    [
      ['1-1-A', '隔着门问清来意', '1-2-A'],
      ['1-1-B', '直接拉开门', '1-2-B'],
    ],
  );
  assert.deepEqual(edges.find(edge => edge.from === '1-1' && edge.to === '1-2-B'), {
    from: '1-1',
    to: '1-2-B',
    label: '直接拉开门',
  });
  assert.deepEqual(edges.find(edge => edge.from === '1-2-A' && edge.to === '1-3'), { from: '1-2-A', to: '1-3' });
  assert.equal(stats.scenes, 6);
});

test('a scene that two routes merge into is a convergence, and a stranded scene is a dead end', () => {
  const merged = buildBranchGraph(script.replace('1-3 堂屋（夜）\n△两人对坐，茶已凉。\n1-3-互动 接下来怎么办？\n1-3-A：留他过夜 → 1-4-A\n1-3-B：送他出门 → 1-4-B', '1-3 堂屋（夜）\n△两人对坐，茶已凉。\n（闭合）'));
  assert.equal(merged.nodes.find(node => node.id === '1-3').kind, 'convergence');
  const stranded = buildBranchGraph(script.replace('（闭合）\n', '△他走了。\n').replace('本集结束', '1-5 尾声\n△完。\n本集结束'));
  assert.equal(stranded.nodes.find(node => node.id === '1-4-B').kind, 'dead_end');
});

test('narrative summaries skip state and condition lines and are capped', () => {
  const { nodes } = buildBranchGraph(script);
  assert.equal(nodes.find(node => node.id === '1-2-A').summary, '林川：你先说名字。');
  const long = buildBranchGraph(script.replace('△两人对坐，茶已凉。', `△${'很长的描写'.repeat(30)}`));
  assert.equal([...long.nodes.find(node => node.id === '1-3').summary].length, 60);
});

test('the real agent returns the full graph to the UI while the model only sees a summary', async t => {
  const f = await fixture(t);
  f.responses.push({ calls: [{ name: 'show_branch_graph', args: { script } }] });
  f.responses.push({ text: '结构已展示。' });
  const result = await f.agent.generate('画出分支结构', runOptions());
  const output = toolResults(result)[0].payload.result;
  assert.equal(output.nodes.length, 6);
  assert.ok(output.edges.length >= 6);
  const toolMessage = f.requests.at(-1).messages.find(message => message.role === 'tool');
  assert.match(toolMessage.content, /^分支图已展示给用户：6 个场景，2 个结局/);
  assert.doesNotMatch(toolMessage.content, /nodes|edges|toNode/);
});
