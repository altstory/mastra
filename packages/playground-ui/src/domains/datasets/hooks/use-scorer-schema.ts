import { t as studioT } from '@mastra/playground-ui/lib/i18n';
import type { JSONSchema7 } from 'json-schema';

/**
 * JSON Schema for MastraDBMessage
 */
const CONTENT_SCHEMA: JSONSchema7 = {
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      get description() {
        return studioT('Structured content (format 2 with parts)');
      },
    },
    {
      type: 'array',
      get description() {
        return studioT('Content parts array');
      },
      items: { type: 'object' },
    },
  ],
};

const MESSAGE_SCHEMA: JSONSchema7 = {
  type: 'object',
  properties: {
    role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
    content: CONTENT_SCHEMA,
  },
  required: ['role', 'content'],
};

/**
 * JSON Schema for ScorerRunInputForAgent (used as scoringInput.input)
 */
const SCORER_RUN_INPUT_FOR_AGENT: JSONSchema7 = {
  type: 'object',
  get description() {
    return studioT('ScorerRunInputForAgent');
  },
  properties: {
    inputMessages: {
      type: 'array',
      get description() {
        return studioT('User input messages (MastraDBMessage[])');
      },
      items: MESSAGE_SCHEMA,
    },
    rememberedMessages: {
      type: 'array',
      get description() {
        return studioT('Messages from memory (MastraDBMessage[])');
      },
      items: MESSAGE_SCHEMA,
    },
    systemMessages: {
      type: 'array',
      get description() {
        return studioT('System messages (CoreMessage[])');
      },
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['system'] },
          content: CONTENT_SCHEMA,
        },
        required: ['role', 'content'],
      },
    },
    taggedSystemMessages: {
      type: 'object',
      get description() {
        return studioT('Tagged system messages (Record<string, CoreSystemMessage[]>)');
      },
      additionalProperties: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['system'] },
            content: CONTENT_SCHEMA,
          },
          required: ['role', 'content'],
        },
      },
    },
  },
  required: ['inputMessages', 'rememberedMessages', 'systemMessages', 'taggedSystemMessages'],
};

/**
 * JSON Schema for ScorerRunOutputForAgent (used as scoringInput.output)
 * MastraDBMessage[]
 */
const SCORER_RUN_OUTPUT_FOR_AGENT: JSONSchema7 = {
  type: 'array',
  get description() {
    return studioT('ScorerRunOutputForAgent (MastraDBMessage[])');
  },
  items: MESSAGE_SCHEMA,
};

/**
 * JSON Schema for scorer input (scoringInputSchema) for agent-type scorers.
 * - input: ScorerRunInputForAgent
 * - output: ScorerRunOutputForAgent
 */
const SCORER_AGENT_INPUT_SCHEMA: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  get description() {
    return studioT('Scorer input for agent-type scorers (scoringInputSchema)');
  },
  properties: {
    runId: {
      type: 'string',
      get description() {
        return studioT('Run ID (optional)');
      },
    },
    input: SCORER_RUN_INPUT_FOR_AGENT,
    output: SCORER_RUN_OUTPUT_FOR_AGENT,
    additionalContext: {
      type: 'object',
      get description() {
        return studioT('Additional context (optional)');
      },
      additionalProperties: true,
    },
    requestContext: {
      type: 'object',
      get description() {
        return studioT('Request context (optional)');
      },
      additionalProperties: true,
    },
  },
  required: [],
};

/**
 * JSON Schema for scorer input (scoringInputSchema) for custom scorers.
 * - input: any
 * - output: any
 */
const SCORER_CUSTOM_INPUT_SCHEMA: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  get description() {
    return studioT('Scorer input for custom scorers (scoringInputSchema)');
  },
  properties: {
    runId: {
      type: 'string',
      get description() {
        return studioT('Run ID (optional)');
      },
    },
    input: {
      get description() {
        return studioT('Input to the entity being scored (any)');
      },
    },
    output: {
      get description() {
        return studioT('Output from the entity being scored (any)');
      },
    },
    additionalContext: {
      type: 'object',
      get description() {
        return studioT('Additional context (optional)');
      },
      additionalProperties: true,
    },
    requestContext: {
      type: 'object',
      get description() {
        return studioT('Request context (optional)');
      },
      additionalProperties: true,
    },
  },
  required: [],
};

/**
 * JSON Schema for scorer ground truth — permissive, accepts any shape.
 * Ground truth depends on what the scorer evaluates and is user-defined.
 */
const SCORER_OUTPUT_SCHEMA: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  get description() {
    return studioT('Scorer ground truth (any shape)');
  },
};

/**
 * Hook that returns scorer input/output schemas.
 * - agentInputSchema: for agent-type scorers (ScorerRunInputForAgent/ScorerRunOutputForAgent)
 * - customInputSchema: for custom scorers (input/output as any)
 * - outputSchema: score + reason from scoreRowDataSchema
 */
export function useScorerSchema() {
  return {
    agentInputSchema: SCORER_AGENT_INPUT_SCHEMA,
    customInputSchema: SCORER_CUSTOM_INPUT_SCHEMA,
    outputSchema: SCORER_OUTPUT_SCHEMA,
    isLoading: false,
    error: null as Error | null,
  };
}
