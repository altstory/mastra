import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeScript, createScriptGraphTool } from '../src/mastra/tools/script-analysis.ts';
import { analyzeScriptState } from '../src/mastra/tools/script-state.ts';

const script = (extra = {}) => `第1集 雨夜来客
1-1 老宅门口（夜）
△雨声里，门被敲响。
1-1-互动 门外的人说是旧识，开不开门？
1-1-A：隔着门问清来意 → 1-2-A
1-1-B：直接拉开门 → 1-2-B
1-2-A 门内
${extra.a ?? '（状态：SV_trust+10；FLAG_know_name=真）'}
林川：你先说名字。
（合流 → 1-3）
1-2-B 门口
${extra.b ?? '（状态：SV_trust-10）'}
△来人一把按住门框。
（合流 → 1-3）
1-3 堂屋（夜）
${extra.c ?? '（若 FLAG_know_name）林川直呼其名：老陈。\n（若 SV_trust<30）来人始终没有摘下斗笠。'}
△两人对坐，茶已凉。
1-3-互动 接下来怎么办？
1-3-A：留他过夜 → 1-4-A
1-3-B：送他出门 → 1-4-B
1-4-A 客房
（若 FLAG_know_name）老陈低声道谢。
（闭合）
1-4-B 门口
（若 FLAG_know_name）老陈回头看了他一眼。
（闭合）
本集结束
`;

const variables = [
  { name: 'SV_trust', min: 0, max: 100, initial: 50 },
  { name: 'FLAG_know_name', initial: false },
];
const rules = (text, vars) => analyzeScriptState(text, vars).map(issue => issue.rule);

test('a script with defined variables, readable conditions and short options is clean', () => {
  assert.deepEqual(analyzeScriptState(script(), variables), []);
});

test('without a variable list, definitions are not checked but usage still is', () => {
  assert.deepEqual(analyzeScriptState(script()), []);
  assert.ok(rules(script({ a: '（状态：SV_trust+10；FLAG_know_name=真；FLAG_extra=真）' })).includes('状态遗忘'));
});

test('a variable that is used but not defined is an error', () => {
  const found = analyzeScriptState(script({ a: '（状态：SV_trust+10；FLAG_know_name=真；FLAG_secret=真）' }), variables);
  const issue = found.find(item => item.rule === '状态未定义');
  assert.equal(issue?.severity, 'error');
  assert.match(issue.message, /FLAG_secret/);
});

test('a flag cannot be incremented and a number cannot be set to true', () => {
  assert.ok(rules(script({ a: '（状态：FLAG_know_name+1）' })).includes('状态类型'));
  assert.ok(rules(script({ b: '（状态：SV_trust=真）' })).includes('状态类型'));
});

test('a change larger than the range, an absolute value outside it and a bad initial value are errors', () => {
  assert.ok(rules(script({ a: '（状态：SV_trust+150）' })).includes('状态越界'));
  assert.ok(rules(script({ a: '（状态：SV_trust=130）' })).includes('状态越界'));
  assert.ok(rules(script(), [{ name: 'SV_trust', initial: 130 }]).includes('状态越界'));
  assert.equal(rules(script({ a: '（状态：SV_trust+20）' }), variables).includes('状态越界'), false);
});

test('a flag read in fewer than three scenes is forgotten, a number never read has no effect', () => {
  const few = script({ c: '（若 FLAG_know_name）林川直呼其名：老陈。' })
    .replace('（若 FLAG_know_name）老陈低声道谢。', '老陈低声道谢。')
    .replace('（若 FLAG_know_name）老陈回头看了他一眼。', '老陈回头看了他一眼。');
  const forgotten = analyzeScriptState(few, variables).find(item => item.rule === '状态遗忘');
  assert.match(forgotten.message, /FLAG_know_name/);
  assert.ok(analyzeScriptState(few, variables).some(item => item.rule === '状态无差异' && item.message.includes('SV_trust')));
});

test('a condition on a flag that is never set can never hold', () => {
  const issues = analyzeScriptState(script({ a: '', b: '' }), variables);
  assert.ok(issues.some(item => item.rule === '状态未设置' && item.message.includes('FLAG_know_name')));
  const initiallyTrue = analyzeScriptState(script({ a: '', b: '' }), [{ name: 'FLAG_know_name', initial: true }]);
  assert.equal(initiallyTrue.some(item => item.rule === '状态未设置'), false);
});

test('an option longer than twenty characters is reported with its id', () => {
  const long = script().replace('隔着门问清来意', '隔着门慢慢地问清楚对方到底是谁又为什么半夜来');
  const issue = analyzeScriptState(long, variables).find(item => item.rule === '选项过长');
  assert.deepEqual(issue.scenes, ['1-1-A']);
});

test('graph issues and state issues come back together', () => {
  const broken = script({ a: '（状态：SV_trust+150）' }).replace('（合流 → 1-3）\n1-2-B', '\n1-2-B');
  const report = analyzeScript(broken, variables);
  assert.ok(report.issues.some(issue => issue.rule === '死路'));
  assert.ok(report.issues.some(issue => issue.rule === '状态越界'));
});

test('analyze_script_graph accepts a variable list and reports state problems', async () => {
  const result = await createScriptGraphTool().execute(
    { script: script({ a: '（状态：SV_trust+10；FLAG_secret=真）' }), variables },
    {},
  );
  assert.ok(result.issues.some(issue => issue.rule === '状态未定义'));
});
