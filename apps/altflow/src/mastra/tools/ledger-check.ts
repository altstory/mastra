import type { LedgerEntry } from '../services/story-ledger';
import { parseScenes } from './script-graph';

export interface LedgerIssue {
  severity: 'error' | 'warn';
  rule: string;
  message: string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function checkAgainstLedger(script: string, entries: LedgerEntry[]): LedgerIssue[] {
  const scenes = parseScenes(script);
  if (!scenes.length) return [];
  const lastEpisode = Math.max(...scenes.map(scene => scene.episode));
  const issues: LedgerIssue[] = [];

  for (const entry of entries) {
    if (entry.kind === 'foreshadow' && !entry.revealedEpisode && entry.plannedRevealEpisode) {
      if (entry.plannedRevealEpisode <= lastEpisode)
        issues.push({
          severity: 'warn',
          rule: '伏笔未回收',
          message: `伏笔「${entry.key}」（第 ${entry.episode} 集埋设）计划在第 ${entry.plannedRevealEpisode} 集回收，台账里仍未回收。若已写入剧本，请更新台账；否则需要补写或调整计划。`,
        });
    }
    if (entry.kind === 'character' && entry.status === 'dead') {
      const speaking = new RegExp(`^${escape(entry.key)}\\s*(?:[（(][^）)]*[）)])?\\s*[：:]`);
      const scene = scenes.find(
        candidate => candidate.episode > entry.episode && candidate.body.some(line => speaking.test(line)),
      );
      if (scene)
        issues.push({
          severity: 'error',
          rule: '角色状态矛盾',
          message: `角色「${entry.key}」在第 ${entry.episode} 集已死亡，但场景 ${scene.key} 中仍有他的台词。`,
        });
    }
  }
  return issues;
}
