import {
  createTavilyProvider,
  createDeepSeekSearchProvider,
  createWebSearchTool,
  createSessionSearchTool,
  createPresentTool,
} from '@mastra/altflow-tools';
import type { DeliveryService, SessionSearchService } from '@mastra/altflow-tools';
import {
  webFetchTool,
  submitPlanTool,
  taskWriteTool,
  taskUpdateTool,
  taskCompleteTool,
  taskCheckTool,
} from '@mastra/core/tools';
import type { ToolAction } from '@mastra/core/tools';
import type { StoryLedgerStore } from '../services/story-ledger';
import { creatorQuestionTool } from './creator-question';
import { creativeBriefTool } from './creative-brief';
import { createBranchGraphTool } from './branch-graph';
import { createProjectStatusTool } from './project-status';
import type { ProjectFiles } from './project-status';
import { createScriptGraphTool } from './script-analysis';
import { createStoryLedgerTools } from './story-ledger';
import { createValidateScriptFormatTool } from './validate-script-format';

export function createCreatorTools(options: {
  countText: ToolAction<any, any>;
  sessionSearch: SessionSearchService;
  delivery: DeliveryService;
  projectFiles: ProjectFiles;
  storyLedger: StoryLedgerStore;
  env?: Record<string, string | undefined>;
}) {
  const env = options.env ?? process.env;
  const providerName = env.ALTFLOW_SEARCH_PROVIDER ?? 'tavily';
  const provider =
    providerName === 'tavily' && env.TAVILY_API_KEY
      ? createTavilyProvider({ apiKey: env.TAVILY_API_KEY, baseURL: env.TAVILY_SEARCH_URL })
      : providerName === 'deepseek' && env.DEEPSEEK_SEARCH_API_KEY
        ? createDeepSeekSearchProvider({ apiKey: env.DEEPSEEK_SEARCH_API_KEY, baseURL: env.DEEPSEEK_SEARCH_URL })
        : undefined;
  const tools = {
    countText: options.countText,
    web_fetch: webFetchTool,
    ask_user: creatorQuestionTool,
    show_creative_brief: creativeBriefTool,
    submit_plan: submitPlanTool,
    task_write: taskWriteTool,
    task_update: taskUpdateTool,
    task_complete: taskCompleteTool,
    task_check: taskCheckTool,
    session_search: createSessionSearchTool({ service: options.sessionSearch }),
    present: createPresentTool({ service: options.delivery }),
    validate_script_format: createValidateScriptFormatTool(),
    project_status: createProjectStatusTool({ files: options.projectFiles, ledger: options.storyLedger }),
    analyze_script_graph: createScriptGraphTool(),
    show_branch_graph: createBranchGraphTool(),
    ...createStoryLedgerTools({ store: options.storyLedger }),
    ...(provider ? { web_search: createWebSearchTool({ provider }) } : {}),
  };
  return { tools, providerConfigured: Boolean(provider), providerName };
}
