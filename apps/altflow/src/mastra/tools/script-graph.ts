const EPISODE = /^(?:#+\s*)?(?:第\s*(\d+)\s*集|EP\s*(\d+))(?:\s*[：:]?\s*.*)?$/i;
const SCENE = /^(\d+)-(\d+)(?:-([A-F]))?\s+\S.*$/;
const INTERACTION = /^(\d+)-(\d+)-互动(?:\s+.*)?$/;
export const OPTION = /^(\d+)-(\d+)-([A-F])\s*[：:]\s*(.*)$/;
export const JUMP = /\s*(?:→|->)\s*(\d+-\d+-[A-F])\s*$/;
const MERGE = /^[（(]\s*合流\s*(?:→|->)\s*(\d+-\d+)\s*[）)]$/;
const CLOSING = /^[（(]\s*(?:闭合|结局\s*[：:].*)[）)]$/;
const EPISODE_END = /^本集结束$/;

export const PATH_COUNT_LIMIT = 128;
export const PATH_LENGTH_RATIO_LIMIT = 2;
export const OPTION_LIMIT = 3;
export const SIMILARITY_LIMIT = 0.9;

export interface GraphIssue {
  severity: 'error' | 'warn';
  rule: string;
  message: string;
  scenes: string[];
}

export interface GraphReport {
  issues: GraphIssue[];
  stats: { scenes: number; endings: number; pathCount: number; minPathScenes: number; maxPathScenes: number };
}

export interface SceneNode {
  key: string;
  episode: number;
  index: number;
  branch: boolean;
  body: string[];
  closed: boolean;
  title: string;
  ending?: string;
  merge?: string;
  options: { id: string; label: string; target?: string }[];
}

function bigrams(text: string) {
  const compact = text.replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let i = 0; i < compact.length - 1; i++) grams.add(compact.slice(i, i + 2));
  return grams;
}

function similarity(a: string, b: string) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return shared / (left.size + right.size - shared);
}

export function parseScenes(script: string) {
  const scenes: SceneNode[] = [];
  let episode = 0;
  let current: SceneNode | undefined;
  let interaction: SceneNode | undefined;
  for (const raw of script.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const ep = line.match(EPISODE);
    if (ep && !SCENE.test(line)) {
      episode = Number(ep[1] ?? ep[2]);
      current = undefined;
      interaction = undefined;
      continue;
    }
    if (EPISODE_END.test(line)) {
      current = undefined;
      interaction = undefined;
      continue;
    }
    if (INTERACTION.test(line)) {
      interaction = current;
      continue;
    }
    const option = line.match(OPTION);
    if (option) {
      interaction?.options.push({
        id: `${option[1]}-${option[2]}-${option[3]}`,
        label: option[4].replace(JUMP, '').trim(),
        target: option[4].match(JUMP)?.[1],
      });
      continue;
    }
    const scene = line.match(SCENE);
    if (scene) {
      current = {
        key: scene[3] ? `${scene[1]}-${scene[2]}-${scene[3]}` : `${scene[1]}-${scene[2]}`,
        episode: Number(scene[1]) || episode,
        index: Number(scene[2]),
        branch: Boolean(scene[3]),
        body: [],
        closed: false,
        title: line.replace(/^\d+-\d+(?:-[A-F])?\s+/, '').trim(),
        options: [],
      };
      interaction = undefined;
      scenes.push(current);
      continue;
    }
    const merge = line.match(MERGE);
    if (merge && current) {
      current.merge = merge[1];
      continue;
    }
    if (CLOSING.test(line) && current) {
      current.closed = true;
      current.ending = line.match(/结局\s*[：:]\s*(.+?)\s*[）)]$/)?.[1];
      continue;
    }
    current?.body.push(line);
  }
  return scenes;
}

export function sceneEdges(scenes: SceneNode[]) {
  const byKey = new Map(scenes.map(scene => [scene.key, scene]));
  const edges = new Map<string, string[]>();
  scenes.forEach((scene, i) => {
    const out: string[] = [];
    if (scene.options.length > 0) {
      for (const option of scene.options) if (option.target && byKey.has(option.target)) out.push(option.target);
    } else if (scene.merge && byKey.has(scene.merge)) {
      out.push(scene.merge);
    } else if (!scene.closed) {
      const next = scenes.slice(i + 1).find(candidate => !candidate.branch);
      if (next && !scene.branch) out.push(next.key);
    }
    edges.set(scene.key, out);
  });
  return edges;
}

export function analyzeScriptGraph(script: string): GraphReport {
  const scenes = parseScenes(script);
  const issues: GraphIssue[] = [];
  const byKey = new Map(scenes.map(scene => [scene.key, scene]));
  const edges = sceneEdges(scenes);

  const reachable = new Set<string>();
  const stack = scenes.length ? [scenes[0].key] : [];
  while (stack.length) {
    const key = stack.pop()!;
    if (reachable.has(key)) continue;
    reachable.add(key);
    stack.push(...(edges.get(key) ?? []));
  }
  for (const scene of scenes) {
    if (!reachable.has(scene.key))
      issues.push({
        severity: 'error',
        rule: '孤立场景',
        message: `场景 ${scene.key} 从开头无法到达。`,
        scenes: [scene.key],
      });
  }

  const last = scenes.at(-1)?.key;
  for (const scene of scenes) {
    const out = edges.get(scene.key) ?? [];
    if (out.length === 0 && !scene.closed && scene.key !== last && reachable.has(scene.key)) {
      issues.push({
        severity: 'error',
        rule: '死路',
        message: `场景 ${scene.key} 进入后无处可去：没有下一场景、合流、闭合或结局。`,
        scenes: [scene.key],
      });
    }
  }

  for (const scene of scenes) {
    if (scene.options.length > OPTION_LIMIT) {
      issues.push({
        severity: 'warn',
        rule: '选项过多',
        message: `场景 ${scene.key} 的互动有 ${scene.options.length} 个选项，超过 ${OPTION_LIMIT} 个容易造成选择负担和路径膨胀。`,
        scenes: [scene.key],
      });
    }
    const targets = scene.options.map(option => option.target).filter((target): target is string => Boolean(target));
    const seen = new Map<string, string>();
    for (const option of scene.options) {
      if (!option.target) continue;
      const previous = seen.get(option.target);
      if (previous) {
        issues.push({
          severity: 'warn',
          rule: '虚假自由',
          message: `选项 ${previous} 和 ${option.id} 跳到同一场景 ${option.target}，选择没有区别。`,
          scenes: [scene.key, option.target],
        });
      }
      seen.set(option.target, option.id);
    }
    const unique = [...new Set(targets)];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const a = byKey.get(unique[i])?.body.join('\n') ?? '';
        const b = byKey.get(unique[j])?.body.join('\n') ?? '';
        if (a.length >= 20 && b.length >= 20 && similarity(a, b) >= SIMILARITY_LIMIT) {
          issues.push({
            severity: 'warn',
            rule: '虚假自由',
            message: `场景 ${unique[i]} 与 ${unique[j]} 的内容几乎相同（相似度不低于 ${Math.round(SIMILARITY_LIMIT * 100)}%），不同选择没有带来不同体验。`,
            scenes: [unique[i], unique[j]],
          });
        }
      }
    }
  }

  const memo = new Map<string, { count: number; min: number; max: number }>();
  const visiting = new Set<string>();
  const walk = (key: string): { count: number; min: number; max: number } => {
    const cached = memo.get(key);
    if (cached) return cached;
    if (visiting.has(key)) return { count: 0, min: Infinity, max: 0 };
    visiting.add(key);
    const out = edges.get(key) ?? [];
    let result: { count: number; min: number; max: number };
    if (out.length === 0) {
      result = { count: 1, min: 1, max: 1 };
    } else {
      const children = out.map(walk).filter(child => child.count > 0);
      result = children.length
        ? {
            count: Math.min(
              1e12,
              children.reduce((sum, child) => sum + child.count, 0),
            ),
            min: 1 + Math.min(...children.map(child => child.min)),
            max: 1 + Math.max(...children.map(child => child.max)),
          }
        : { count: 0, min: Infinity, max: 0 };
    }
    visiting.delete(key);
    memo.set(key, result);
    return result;
  };
  const total = scenes.length ? walk(scenes[0].key) : { count: 0, min: 0, max: 0 };
  const endings = scenes.filter(scene => (edges.get(scene.key) ?? []).length === 0 && reachable.has(scene.key)).length;
  if (total.count > PATH_COUNT_LIMIT) {
    issues.push({
      severity: 'warn',
      rule: '路径膨胀',
      message: `从开头到结尾共有约 ${total.count} 条不同路径，超过 ${PATH_COUNT_LIMIT} 条，内容量难以控制。建议增加收束点。`,
      scenes: [],
    });
  }
  if (Number.isFinite(total.min) && total.min > 0 && total.max / total.min >= PATH_LENGTH_RATIO_LIMIT) {
    issues.push({
      severity: 'warn',
      rule: '路径失衡',
      message: `最长路径经过 ${total.max} 个场景，最短只有 ${total.min} 个，相差 ${PATH_LENGTH_RATIO_LIMIT} 倍以上，不同路径的体验量差距过大。`,
      scenes: [],
    });
  }

  return {
    issues,
    stats: {
      scenes: scenes.length,
      endings,
      pathCount: total.count,
      minPathScenes: Number.isFinite(total.min) ? total.min : 0,
      maxPathScenes: total.max,
    },
  };
}
