import type { GetMemoryConfigResponse } from '@mastra/client-js';
import { t as studioT } from '@mastra/playground-ui/lib/i18n';

type MemoryConfig = NonNullable<GetMemoryConfigResponse['config']>;

export function getRecentMessagesSettings(
  lastMessages: MemoryConfig['lastMessages'],
  messageHistory?: MemoryConfig['messageHistory'],
) {
  const maxTokens = messageHistory?.maxTokens;
  const maxMessages = typeof lastMessages === 'number' ? lastMessages : undefined;
  const enabled =
    lastMessages !== false &&
    maxMessages !== 0 &&
    maxTokens !== 0 &&
    (maxMessages !== undefined || maxTokens !== undefined);

  if (!enabled) {
    return {
      enabled,
      maxMessages: undefined,
      get description() {
        return studioT('Recent message history is not included in context.');
      },
    };
  }

  const description =
    maxMessages === undefined
      ? maxTokens === undefined
        ? studioT('Includes recent message history in context.')
        : studioT(
            'Includes recent message history with a {tokens}-token context budget, trimming oldest history first.',
            { tokens: maxTokens },
          )
      : maxTokens === undefined
        ? maxMessages === 1
          ? studioT('Includes the last 1 message in context.')
          : studioT('Includes the last {count} messages in context.', { count: maxMessages })
        : maxMessages === 1
          ? studioT(
              'Includes the last 1 message with a {tokens}-token context budget, trimming oldest history first.',
              { tokens: maxTokens },
            )
          : studioT(
              'Includes the last {count} messages with a {tokens}-token context budget, trimming oldest history first.',
              { count: maxMessages, tokens: maxTokens },
            );

  return { enabled, maxMessages, description };
}
