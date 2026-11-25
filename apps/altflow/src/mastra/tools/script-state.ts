import { JUMP, OPTION, parseScenes } from './script-graph';
import type { GraphIssue } from './script-graph';

export interface StateVariable {
  name: string;
  min?: number;
  max?: number;
  initial?: number | boolean;
}

export const OPTION_TEXT_LIMIT = 20;
export const FLAG_USE_MINIMUM = 3;

const VARIABLE = /(?:SV|FLAG|ITEM|COUNTER)_\w+/g;
const CHANGE = /^((?:SV|FLAG|ITEM|COUNTER)_\w+)\s*(\+\d+(?:\.\d+)?|-\d+(?:\.\d+)?|=\s*-?\d+(?:\.\d+)?|=\s*(?:真|假|true|false))$/;
const STATE_LINE = /^[（(]\s*状态\s*[：:]\s*(.+?)\s*[）)]$/;
const CONDITION_LINE = /^[（(]\s*若\s+([^）)]+)[）)]/;

const kindOf = (name: string) => name.slice(0, name.indexOf('_'));
const isNumeric = (name: string) => kindOf(name) === 'SV' || kindOf(name) === 'COUNTER';

interface Change {
  name: string;
  op: string;
  scene: string;
}

function collect(script: string) {
  const changes: Change[] = [];
  const reads = new Map<string, Set<string>>();
  const sets = new Map<string, Set<string>>();
  for (const scene of parseScenes(script)) {
    for (const line of scene.body) {
      const state = line.match(STATE_LINE);
      if (state) {
        for (const part of state[1].split(/[；;，,]/).map(item => item.trim()).filter(Boolean)) {
          const change = part.match(CHANGE);
          if (!change) continue;
          changes.push({ name: change[1], op: change[2].replace(/\s+/g, ''), scene: scene.key });
          sets.set(change[1], (sets.get(change[1]) ?? new Set()).add(scene.key));
        }
        continue;
      }
      const condition = line.match(CONDITION_LINE);
      if (condition)
        for (const name of condition[1].match(VARIABLE) ?? [])
          reads.set(name, (reads.get(name) ?? new Set()).add(scene.key));
    }
  }
  return { changes, reads, sets };
}

export function analyzeScriptState(script: string, variables?: StateVariable[]): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const { changes, reads, sets } = collect(script);
  const defined = variables?.length ? new Map(variables.map(variable => [variable.name, variable])) : undefined;
  const used = new Set([...sets.keys(), ...reads.keys()]);

  for (const line of script.split(/\r?\n/)) {
    const option = line.trim().match(OPTION);
    if (!option) continue;
    const text = option[4].replace(JUMP, '').trim();
    if ([...text].length > OPTION_TEXT_LIMIT)
      issues.push({
        severity: 'warn',
        rule: '选项过长',
        message: `选项 ${option[1]}-${option[2]}-${option[3]} 的文字有 ${[...text].length} 个字，建议不超过 ${OPTION_TEXT_LIMIT} 字。`,
        scenes: [`${option[1]}-${option[2]}-${option[3]}`],
      });
  }

  if (defined) {
    for (const name of used)
      if (!defined.has(name))
        issues.push({
          severity: 'error',
          rule: '状态未定义',
          message: `${name} 在剧本里被使用，但不在状态变量清单中，请先补进《互动设计文档》的清单。`,
          scenes: [...(sets.get(name) ?? []), ...(reads.get(name) ?? [])],
        });
    for (const variable of defined.values()) {
      const [low, high] = [variable.min ?? 0, variable.max ?? 100];
      if (isNumeric(variable.name) && typeof variable.initial === 'number' && (variable.initial < low || variable.initial > high))
        issues.push({
          severity: 'error',
          rule: '状态越界',
          message: `${variable.name} 的初始值 ${variable.initial} 超出范围 ${low} 到 ${high}。`,
          scenes: [],
        });
    }
  }

  for (const change of changes) {
    const numericOp = /^[+-]|^=-?\d/.test(change.op);
    if (isNumeric(change.name) !== numericOp)
      issues.push({
        severity: 'error',
        rule: '状态类型',
        message: `${change.name} 是${isNumeric(change.name) ? '数值' : '标志'}变量，不能写成 ${change.op}。`,
        scenes: [change.scene],
      });
    else if (kindOf(change.name) === 'SV' && numericOp) {
      const variable = defined?.get(change.name);
      const [low, high] = [variable?.min ?? 0, variable?.max ?? 100];
      const value = Number(change.op.replace('=', ''));
      const outside = change.op.startsWith('=') ? value < low || value > high : Math.abs(value) > high - low;
      if (outside)
        issues.push({
          severity: 'error',
          rule: '状态越界',
          message: `${change.name} 的变更 ${change.op} 超出范围 ${low} 到 ${high}。`,
          scenes: [change.scene],
        });
    }
  }

  for (const [name, places] of sets) {
    const readIn = reads.get(name)?.size ?? 0;
    if (isNumeric(name) && readIn === 0)
      issues.push({
        severity: 'warn',
        rule: '状态无差异',
        message: `${name} 被修改过，但没有任何条件文本读取它，不同选择没有留下可见的差异。`,
        scenes: [...places],
      });
    else if (!isNumeric(name) && readIn < FLAG_USE_MINIMUM)
      issues.push({
        severity: 'warn',
        rule: '状态遗忘',
        message: `${name} 被设置后只在 ${readIn} 个场景的条件文本中用到，建议至少 ${FLAG_USE_MINIMUM} 个，否则这个选择的后续影响太弱。`,
        scenes: [...places, ...(reads.get(name) ?? [])],
      });
  }

  for (const [name, places] of reads) {
    const variable = defined?.get(name);
    if (!isNumeric(name) && !sets.has(name) && variable?.initial !== true)
      issues.push({
        severity: 'warn',
        rule: '状态未设置',
        message: `${name} 在条件文本里被读取，但剧本中从没有设置过，这个条件永远不会成立。`,
        scenes: [...places],
      });
  }
  return issues;
}
