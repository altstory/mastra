/** Operating capacities from the local DSH ModelHub integration; physical limits may be smaller. */
export const CONTEXT_POLICY = Object.freeze({
  contextWindow: 262_144,
  maxOutputTokens: 8_192,
  thresholdRatio: 0.8,
  headroomTokens: 65_536,
  retainRatio: 0.16,
});
export function contextPolicy(physicalInput?: number) {
  const window = Math.min(physicalInput ?? CONTEXT_POLICY.contextWindow, CONTEXT_POLICY.contextWindow);
  const output = CONTEXT_POLICY.maxOutputTokens;
  const messageBudget = window - output;
  const headroom = CONTEXT_POLICY.headroomTokens;
  if (messageBudget <= headroom) throw new Error('Model context capacity leaves no DSH compaction headroom');
  return {
    window,
    output,
    threshold: Math.floor(Math.min(window * CONTEXT_POLICY.thresholdRatio, messageBudget - headroom)),
    retain: Math.floor(messageBudget * CONTEXT_POLICY.retainRatio),
  };
}
