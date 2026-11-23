import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import type { TaskItem } from '@mastra/react';
import { hashKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useConversationStatus } from '@/domains/navigation/use-conversation-status';

type LiveTranscript = {
  messages: MastraDBMessage[];
  tasks: TaskItem[];
  runId: string;
};

function lastRunMessage(messages: MastraDBMessage[], runId: string) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.content.metadata?.runId === runId) return message;
  }
}

function reachedSnapshot(messages: MastraDBMessage[], snapshot: LiveTranscript) {
  // The server replays the run in order; use the last assistant message as the checkpoint.
  const previous = lastRunMessage(snapshot.messages, snapshot.runId);
  if (!previous) return true;
  const incoming = messages.find(
    message => message.id === previous.id && message.content.metadata?.runId === snapshot.runId,
  );
  if (!incoming) return false;
  return previous.content.parts.every((part, index) => {
    const next = incoming.content.parts[index];
    if (!next || part.type !== next.type) return false;
    if (part.type === 'text' && next.type === 'text') return next.text.startsWith(part.text);
    if (part.type === 'reasoning' && next.type === 'reasoning') {
      return (next.reasoning ?? '').startsWith(part.reasoning ?? '');
    }
    if (part.type === 'tool-invocation' && next.type === 'tool-invocation') {
      const call = part.toolInvocation;
      const nextCall = next.toolInvocation;
      if (nextCall.toolCallId !== call.toolCallId) return false;
      if (nextCall.state === 'result' && call.state !== 'result') return true;
      return hashKey([call]) === hashKey([nextCall]);
    }
    return true;
  });
}

export function useLiveTranscript(
  scope: string | undefined,
  accountScope: string | undefined,
  threadId: string,
  live: Omit<LiveTranscript, 'runId'> & { runId?: string; running: boolean },
) {
  const client = useQueryClient();
  const [resume, setResume] = useState(() => ({
    since: Date.now(),
    snapshot: scope ? client.getQueryData<LiveTranscript>(['conversation-live-transcript', scope]) : undefined,
  }));
  const [revealedIds] = useState(() => new Set(resume.snapshot?.messages.map(message => message.id)));
  const snapshot = resume.snapshot;
  const status = useConversationStatus(accountScope ?? '', Boolean(snapshot && accountScope));
  const hasFreshStatus = status.isSuccess && status.dataUpdatedAt >= resume.since;
  const inactive = hasFreshStatus && status.data && !status.data.running.includes(threadId);
  const caughtUp = snapshot && live.runId === snapshot.runId && reachedSnapshot(live.messages, snapshot);
  const replaced = snapshot && live.runId && live.runId !== snapshot.runId;
  const replaying = snapshot && !inactive && !caughtUp && !replaced ? snapshot : undefined;
  if (snapshot && !replaying) setResume({ ...resume, snapshot: undefined });

  const latest = useRef<LiveTranscript | undefined>(undefined);
  useLayoutEffect(() => {
    latest.current =
      replaying ??
      (live.running && live.runId && lastRunMessage(live.messages, live.runId)
        ? { runId: live.runId, messages: live.messages, tasks: live.tasks }
        : undefined);
  }, [live.messages, live.runId, live.running, live.tasks, replaying]);
  useLayoutEffect(() => {
    if (!scope) return;
    const key = ['conversation-live-transcript', scope];
    return () => {
      if (latest.current) client.setQueryData(key, latest.current);
      else client.removeQueries({ queryKey: key, exact: true });
    };
  }, [client, scope]);

  // The snapshot is only a bridge. If the runtime cannot confirm the run or
  // resume its stream, fall back to the freshly loaded history.
  useEffect(() => {
    if (!snapshot || (hasFreshStatus && status.data)) return;
    const timeout = setTimeout(() => setResume(current => ({ ...current, snapshot: undefined })), 10_000);
    return () => clearTimeout(timeout);
  }, [hasFreshStatus, snapshot, status.data]);

  return { replaying, revealedIds };
}
