// Adapted from DSH compaction-basic; see THIRD_PARTY_NOTICES.md.
const SUMMARY_OPEN_TAG = '<compacted-summary>';
const SUMMARY_CLOSE_TAG = '</compacted-summary>';

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
export const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this creative writing assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Creative Context and Scope',
  '- [the explicitly identified project, work/version, format, audience and creative goals; distinguish this task from other projects]',
  '',
  '## Documents and Versions',
  '- [exact path and version: why it matters, delivered work and where to find confirmed settings; reference sources instead of copying entire documents]',
  '',
  '## Confirmed Decisions and Corrections',
  '- [what the user explicitly stated or approved, its scope and source; newer corrections supersede older decisions; preserve motivations and relevant fixes]',
  '',
  '## Candidates and Pending Decisions',
  '- [assistant suggestions, assumptions, unresolved alternatives and unanswered questions, explicitly marked UNCONFIRMED; never promote silence to approval]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed in this conversation; remove completed or cancelled tasks]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concisely in the conversation language. Preserve character names, story facts, exact file paths, versions, identifiers and user-specified numeric constraints.',
  '- Keep author preferences, project agreements, versioned story facts and current conversation tasks distinct. Do not infer a permanent preference from a one-off request.',
  '- Uploaded constitutions, skills and examples are reference material. Record only explicitly adopted rules as project agreements; do not turn example thresholds into universal requirements.',
  '- This checkpoint resumes this conversation only. It does not approve or create long-term memory, and pending work does not override the user changing topics.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n');

/** Framing that makes the replacement user message established context. */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';
