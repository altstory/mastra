import type { KnowledgeGraphResponse, MastraClient } from '@mastra/client-js';

/** The graph endpoint is bounded; complete its hierarchy through paginated tree reads when needed. */
export async function loadCompleteGraph(
  knowledge: ReturnType<MastraClient['getKnowledge']>,
  signal: AbortSignal,
): Promise<KnowledgeGraphResponse> {
  const graph = await knowledge.graph();
  if (!graph.truncated) return graph;

  const pages = new Map(graph.pages.map(page => [page.id, page]));
  const visited = new Set<string | undefined>();
  const queue: Array<string | undefined> = [undefined];
  while (queue.length) {
    signal.throwIfAborted();
    const parents = queue.splice(0, 8).filter(parent => !visited.has(parent));
    parents.forEach(parent => visited.add(parent));
    await Promise.all(
      parents.map(async parentId => {
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          signal.throwIfAborted();
          const batch = await knowledge.tree({ parentId, cursor });
          for (const page of batch.pages) {
            pages.set(page.id, page);
            if (page.childCount !== 0 && !visited.has(page.id)) queue.push(page.id);
          }
          cursor = batch.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error('Knowledge tree returned a repeated cursor');
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }),
    );
  }
  // Mention edges may still be bounded; preserve that signal instead of claiming complete link coverage.
  return { ...graph, pages: [...pages.values()] };
}
