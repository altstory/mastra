import { createServer } from 'node:http';
export const catalogFixture = () => ({
  config_version: 1,
  free_chat_models: [
    {
      id: 'deepseek-v4-pro',
      display_name: 'DeepSeek V4 Pro',
      sort_order: 1,
      default_thinking_level: 'off',
      thinking_options: [
        {
          level: 'off',
          target: 'internal-deepseek-route',
          supports_thinking_level: false,
          supports_thinking_budget: false,
        },
      ],
    },
    {
      id: 'qwen3.8-max',
      display_name: 'Qwen3.8 Max',
      sort_order: 2,
      default_thinking_level: 'high',
      thinking_options: [
        {
          level: 'high',
          target: 'internal-qwen-route',
          supports_thinking_level: true,
          supports_thinking_budget: true,
          agent_budget_tokens: 8000,
        },
      ],
    },
  ],
});
export async function modelHubFixture() {
  const state = {
    catalog: catalogFixture(),
    requests: [],
    catalogs: 0,
    infos: 0,
    infoStatus: 200,
    info: {
      data: [
        { model_name: 'internal-deepseek-route', model_info: { max_input_tokens: 1048576, max_output_tokens: 131072 } },
        { model_name: 'internal-qwen-route', model_info: { max_input_tokens: 983616 } },
      ],
    },
    unavailable: false,
    toolCallText: undefined,
    toolCall: undefined,
    replyParts: undefined,
    blocked: false,
    summaryText: '## Primary Request and Intent\n- Preserve original task.\n## Current Work\n- Continue the task.',
    summaryFinish: 'stop',
    rejectContextOnce: false,
  };
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/model-catalog') {
      state.catalogs++;
      response.writeHead(state.unavailable ? 503 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(state.catalog));
    } else if (request.url === '/model/info') {
      state.infos++;
      response.writeHead(state.infoStatus, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(state.info));
    } else if (request.url === '/v1/chat/completions') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      state.requests.push({ body: JSON.parse(raw), authorization: request.headers.authorization });
      const body = JSON.parse(raw);
      await state.onRequest?.(body);
      while (state.blocked) await new Promise(resolve => setTimeout(resolve, 20));
      const summarizing = body.messages.at(-1)?.content?.includes('You are now acting as a compaction engine');
      if (state.rejectContextOnce && !summarizing) {
        state.rejectContextOnce = false;
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: 'maximum context length exceeded', code: 'context_length_exceeded' } }),
        );
        return;
      }
      const firstCall = state.toolCall ?? { name: 'countText', args: { text: state.toolCallText } };
      const plannedCall = summarizing
        ? undefined
        : (state.nextToolCall?.(body) ??
          ((state.toolCall !== undefined || state.toolCallText !== undefined) &&
          !body.messages.some(message => message.role === 'tool')
            ? firstCall
            : undefined));
      const callTool = plannedCall && body.tools?.some(tool => tool.function?.name === plannedCall.name);
      const message = callTool
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: plannedCall.id ?? 'count-test',
                type: 'function',
                function: {
                  name: plannedCall.name,
                  arguments: JSON.stringify(plannedCall.args),
                },
              },
            ],
          }
        : { role: 'assistant', content: summarizing ? state.summaryText : (state.replyParts?.join('') ?? 'verified') };
      const finishReason = summarizing ? state.summaryFinish : callTool ? 'tool_calls' : 'stop';
      const usage =
        state.usage ??
        (summarizing
          ? {
              prompt_tokens: 100,
              completion_tokens: 1,
              total_tokens: 101,
              prompt_tokens_details: { cached_tokens: 80 },
            }
          : { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = delta => ({
          id: 'test-completion',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test',
          choices: [{ index: 0, delta, finish_reason: null }],
        });
        const delta = callTool
          ? {
              role: 'assistant',
              tool_calls: message.tool_calls.map(tool => ({ index: 0, ...tool })),
            }
          : message;
        for (const part of callTool || summarizing || !state.replyParts
          ? [delta]
          : state.replyParts.map(content => ({ role: 'assistant', content }))) {
          response.write('data: ' + JSON.stringify(chunk(part)) + '\n\n');
        }
        response.write(
          'data: ' +
            JSON.stringify({
              ...chunk({}),
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
              ...(body.stream_options?.include_usage ? { usage } : {}),
            }) +
            '\n\n',
        );
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'test-completion',
            object: 'chat.completion',
            created: 1,
            model: 'test',
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage,
          }),
        );
      }
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    state,
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}
