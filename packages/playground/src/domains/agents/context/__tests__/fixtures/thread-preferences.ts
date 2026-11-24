import type { RouteResponse } from '@mastra/client-js';

export const allowedModels: RouteResponse<'GET /editor/builder/models/available'> = {
  providers: [{ id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', connected: true, models: ['gpt-4o-mini'] }],
};
export const restrictedModels: RouteResponse<'GET /editor/builder/models/available'> = {
  providers: allowedModels.providers.map(provider => ({ ...provider, models: ['gpt-5-mini'] })),
};
export const currentUser: RouteResponse<'GET /auth/me'> = { id: 'user-1' };
export const memoryConfig: RouteResponse<'GET /memory/config'> = { config: {} };
export const workingMemory: RouteResponse<'GET /memory/threads/:threadId/working-memory'> = {
  workingMemory: null,
  source: 'thread',
  workingMemoryTemplate: null,
  threadExists: false,
};
export const agentModelProviders: RouteResponse<'GET /agents/providers'> = {
  providers: [
    { id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', connected: true, models: ['gpt-4o', 'gpt-4o-mini'] },
  ],
};
export const managedModelProviders: RouteResponse<'GET /agents/providers'> = {
  providers: [
    {
      id: 'altflow',
      name: 'Altflow',
      envVar: 'ALTFLOW_MODELHUB_API_KEY',
      connected: true,
      models: ['qwen3.8-max', 'qwen3.8-flash'],
      modelNames: { 'qwen3.8-max': 'Qwen3.8 Max', 'qwen3.8-flash': 'Qwen3.8 Flash' },
      modelReasoning: {
        'qwen3.8-max': { levels: ['medium', 'high'], defaultLevel: 'medium' },
        'qwen3.8-flash': { levels: ['medium', 'high'], defaultLevel: 'medium' },
      },
    },
  ],
};
