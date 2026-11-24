/** Product models exposed by this Altflow deployment. */
export const conversationModels = ['qwen3.8-flash', 'qwen3.8-max'] as const;
export const conversationModelRoutes = conversationModels.map(model => `altflow/${model}`);
export const defaultConversationModel = 'altflow/qwen3.8-max';
export const defaultReasoningLevel = 'medium';
