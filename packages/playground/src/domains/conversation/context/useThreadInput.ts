import type { DraftStatus } from '@mastra/playground-ui/domains/agents/chat/drafts/thread-draft-state';
import type { ThreadDraft } from '@mastra/playground-ui/domains/agents/chat/drafts/thread-draft-storage';
import { ThreadInputContext } from '@mastra/playground-ui/domains/agents/chat/drafts/thread-input-context';
import { use, useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

type ThreadInputSetter = Dispatch<SetStateAction<string>>;

export const useThreadInput = (
  threadId?: string,
): {
  threadInput: string;
  setThreadInput: ThreadInputSetter;
  draft?: ThreadDraft;
  updateDraft?: Dispatch<SetStateAction<ThreadDraft>>;
  draftStatus?: DraftStatus;
} => {
  const { getThreadInput, setThreadInputForThread, drafts } = use(ThreadInputContext);
  const setThreadInput = useCallback<ThreadInputSetter>(
    value => setThreadInputForThread(threadId, value),
    [setThreadInputForThread, threadId],
  );

  return {
    threadInput: getThreadInput(threadId),
    setThreadInput,
    draft: drafts?.get(threadId),
    updateDraft: drafts ? value => drafts.update(threadId, value) : undefined,
    draftStatus: drafts?.status,
  };
};
