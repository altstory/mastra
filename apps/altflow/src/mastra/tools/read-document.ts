import { MASTRA_NORMALIZED_USER_KEY } from '@mastra/core/request-context';
import { toolIdentity } from '@mastra/altflow-tools';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import type { ToolAction, ToolExecutionContext } from '@mastra/core/tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { isOfficeDocument } from '../services/office';
import type { OfficeReader } from '../services/office';

const inputSchema = z.object({
  path: z.string().min(1).max(2048),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
});
const readFileSchema = inputSchema.extend({ limit: z.number().int().min(1).optional() });
function executable(value: unknown): value is ToolAction<any, any> {
  return Boolean(
    value && typeof value === 'object' && 'id' in value && 'execute' in value && typeof value.execute === 'function',
  );
}
export function createDocumentTools(reader: OfficeReader) {
  const readBody = async (input: z.infer<typeof inputSchema>, owner: string, signal?: AbortSignal) => {
    const text = await reader.read(owner, input.path, signal);
    const lines = text.split(/\r?\n/);
    const offset = input.offset ?? 1;
    const count = input.limit ?? 500;
    let used = 0;
    const selected: string[] = [];
    for (const line of lines.slice(offset - 1, offset - 1 + count)) {
      // Never truncate a line silently; a caller can explicitly request that line.
      if (used + line.length > 80_000) break;
      selected.push(line);
      used += line.length + 1;
    }
    return {
      path: input.path,
      text: selected.join('\n'),
      totalLines: lines.length,
      offset,
      nextOffset: offset - 1 + selected.length < lines.length ? offset + selected.length : null,
      ...(selected.length === 0 && offset <= lines.length
        ? { error: 'A single line exceeds the 80,000 character output limit.' }
        : {}),
    };
  };
  const read = createTool({
    id: 'read_document',
    description:
      'Read plain text (TXT, Markdown, CSV, JSON, XML, HTML) in UTF-8, GBK or GB18030, or read DOC/DOCX/ODT, XLS/XLSX/ODS, PPT/PPTX/ODP or PDF in the authenticated private workspace. Office documents use DSH LibreOffice Kit. Originals stay intact. offset/limit select lines; scanned images require OCR.',
    inputSchema,
    execute: async (input, context) => readBody(input, toolIdentity(context).userId, context?.abortSignal),
  });
  const path = z.string().min(1).max(2048);
  const sheet = z.string().max(240).optional();
  const convert = createTool({
    id: 'office_convert',
    description:
      'Convert a document, workbook, or presentation in the private workspace. CSV conversion accepts an exact sheet name. Deliver the output paths with present.',
    inputSchema: z.object({
      path,
      format: z.enum(['pdf', 'docx', 'odt', 'txt', 'xlsx', 'ods', 'csv', 'pptx', 'odp']),
      sheet,
    }),
    execute: async ({ path, ...options }, context) =>
      reader.produce(toolIdentity(context).userId, path, 'convert', options, context?.abortSignal),
  });
  const render = createTool({
    id: 'office_render',
    description:
      'Render up to eight document pages, slides, or worksheet views as PNG. Open a rendered PNG with the workspace file reader to inspect the layout. Pass one-based page numbers or, for a workbook, a sheet name and optional A1 range. Deliver the output paths with present.',
    inputSchema: z.object({
      path,
      pages: z.array(z.number().int().positive()).min(1).max(8).optional(),
      sheet,
      range: z
        .string()
        .regex(/^\$?[A-Z]{1,3}\$?[1-9]\d{0,6}:\$?[A-Z]{1,3}\$?[1-9]\d{0,6}$/i)
        .optional(),
      dpi: z.number().int().min(24).max(192).optional(),
    }),
    execute: async ({ path, ...options }, context) =>
      reader.produce(toolIdentity(context).userId, path, 'render', options, context?.abortSignal),
  });
  const recalculate = createTool({
    id: 'office_recalculate',
    description: 'Recalculate workbook formulas in a separate XLSX or ODS file. Deliver the output path with present.',
    inputSchema: z.object({ path, format: z.enum(['xlsx', 'ods']).optional() }),
    execute: async ({ path, ...options }, context) =>
      reader.produce(toolIdentity(context).userId, path, 'recalculate', options, context?.abortSignal),
  });
  return {
    tools: { read_document: read, office_convert: convert, office_render: render, office_recalculate: recalculate },
    processor: {
      id: 'altflow-office-reader',
      processInputStep(args: ProcessInputStepArgs) {
        const tools = { ...args.tools };
        // Keep raw encodings available for file copies/downloads; text reads use the body parser.
        for (const [name, tool] of Object.entries(tools)) {
          if (!executable(tool) || tool.id !== 'mastra_workspace_read_file' || !tool.execute) continue;
          const original = tool.execute;
          tools[name] = {
            ...tool,
            execute: async (input: unknown, context: ToolExecutionContext) => {
              const parsed = readFileSchema.safeParse(input);
              const encoding = input && typeof input === 'object' && 'encoding' in input ? input.encoding : undefined;
              if (
                parsed.success &&
                isOfficeDocument(parsed.data.path) &&
                (!encoding || encoding === 'utf8' || encoding === 'utf-8')
              )
                return readBody(
                  { ...parsed.data, limit: Math.min(parsed.data.limit ?? 500, 2000) },
                  z.object({ id: z.string().min(1) }).parse(args.requestContext?.getRaw(MASTRA_NORMALIZED_USER_KEY)).id,
                  context?.abortSignal,
                );
              return original(input, context);
            },
          };
        }
        return { tools };
      },
    },
  };
}
