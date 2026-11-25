import type { MastraClient, RouteResponse } from '@mastra/client-js';
import { EntityType, SpanType } from '@mastra/core/observability';

type SpanRecord = RouteResponse<'GET /observability/traces/:traceId/spans/:spanId'>['span'];

export const spanFixture: SpanRecord = {
  traceId: 'trace-1',
  spanId: 'span-1',
  parentSpanId: null,
  name: 'agent run',
  entityType: null,
  entityId: null,
  entityName: null,
  userId: null,
  organizationId: null,
  resourceId: null,
  runId: null,
  sessionId: null,
  threadId: null,
  requestId: null,
  environment: null,
  source: null,
  serviceName: null,
  scope: null,
  spanType: SpanType.AGENT_RUN,
  attributes: null,
  metadata: null,
  tags: null,
  links: null,
  input: null,
  output: null,
  error: null,
  requestContext: null,
  isEvent: false,
  startedAt: new Date('2026-06-01T10:00:00.000Z'),
  endedAt: new Date('2026-06-01T10:00:01.000Z'),
  createdAt: new Date('2026-06-01T10:00:00.000Z'),
  updatedAt: null,
};

/** The trace the Output tab looks tool results up in; this span made no tool calls. */
export const traceFixture: Awaited<ReturnType<MastraClient['getTrace']>> = {
  traceId: 'trace-1',
  spans: [],
};

export const knowledgeProcessorFixture: SpanRecord = {
  ...spanFixture,
  spanId: 'knowledge-processor',
  parentSpanId: spanFixture.spanId,
  name: 'knowledge',
  entityType: EntityType.INPUT_PROCESSOR,
  entityId: 'knowledge',
  spanType: SpanType.PROCESSOR_RUN,
};

export const knowledgeTraceFixture: typeof traceFixture = {
  ...traceFixture,
  spans: [
    spanFixture,
    knowledgeProcessorFixture,
    {
      ...spanFixture,
      spanId: 'knowledge-pins',
      parentSpanId: spanFixture.spanId,
      name: 'knowledge:pins',
      spanType: SpanType.GENERIC,
      output: {
        stepNumber: 0,
        delivery: 'updated',
        pins: [
          {
            id: 'research-guide',
            name: 'Research guide',
            scope: 'library:creator',
            text: 'Interview two readers before the second draft.',
          },
        ],
      },
    },
  ],
};
