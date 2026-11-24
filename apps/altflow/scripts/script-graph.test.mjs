import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeScriptGraph } from '../src/mastra/tools/script-graph.ts';

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

const rules = text => analyzeScriptGraph(text).issues.map(issue => issue.rule);

test('a connected branching script has no graph issues and counts its paths', () => {
  const report = analyzeScriptGraph(valid);
  assert.deepEqual(report.issues, []);
  assert.equal(report.stats.pathCount, 2);
  assert.equal(report.stats.endings, 1);
});

test('a scene nothing leads to is reported as isolated', () => {
  assert.ok(rules(valid.replace('1-3 堂屋', '1-4 孤屋（夜）\n△无人。\n1-3 堂屋')).includes('孤立场景'));
});

test('a branch scene with no merge and no successor is a dead end', () => {
  assert.ok(rules(valid.replace('（合流 → 1-3）\n1-2-B', '\n1-2-B')).includes('死路'));
});

test('options that lead to the same scene are fake freedom', () => {
  const same = valid.replace('1-1-B：直接拉开门 → 1-2-B', '1-1-B：直接拉开门 → 1-2-A');
  assert.ok(rules(same).includes('虚假自由'));
});

test('two options whose branch bodies are near identical are fake freedom', () => {
  const body = '△来人一把按住门框，雨水顺着袖口淌下来，屋里的灯忽明忽暗。';
  const text = valid.replace('△来人一把按住门框。', body).replace('林川：你先说名字。', body);
  assert.ok(rules(text).includes('虚假自由'));
});

test('an interaction with more than three options is reported', () => {
  const text = `第1集 选择
1-1 路口（日）
△三条路。
1-1-互动 走哪条？
1-1-A：左 → 1-2-A
1-1-B：右 → 1-2-B
1-1-C：中 → 1-2-C
1-1-D：回头 → 1-2-D
1-2-A 左路
△左。
（合流 → 1-3）
1-2-B 右路
△右。
（合流 → 1-3）
1-2-C 中路
△中。
（合流 → 1-3）
1-2-D 回头路
△回。
（合流 → 1-3）
1-3 终点（日）
△到了。
本集结束
`;
  assert.ok(rules(text).includes('选项过多'));
});

test('sequential two-option interactions blow up the path count', () => {
  const episodes = ['第1集 连环选择'];
  for (let i = 1; i <= 8; i += 1) {
    const main = 3 * i - 2;
    const branch = main + 1;
    const next = main + 3;
    episodes.push(
      `1-${main} 场景${i}（日）`,
      `△第${i}段。`,
      `1-${main}-互动 选哪个？`,
      `1-${main}-A：甲 → 1-${branch}-A`,
      `1-${main}-B：乙 → 1-${branch}-B`,
      `1-${branch}-A 甲线${i}`,
      `△甲${i}。`,
      `（合流 → 1-${next}）`,
      `1-${branch}-B 乙线${i}`,
      `△乙${i}。`,
      `（合流 → 1-${next}）`,
    );
  }
  episodes.push('1-25 终局（夜）', '△完。', '本集结束');
  const report = analyzeScriptGraph(episodes.join('\n'));
  assert.ok(report.stats.pathCount > 128);
  assert.ok(report.issues.some(issue => issue.rule === '路径膨胀'));
});
