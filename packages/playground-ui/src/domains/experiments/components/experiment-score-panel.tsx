'use client';

import type { ClientScoreRowData } from '@mastra/client-js';
import { Button } from '@/ds/components/Button';
import { DataPanel } from '@/ds/components/DataPanel';
import { IconGauge } from '@/ds/icons/central/IconGauge';
import { IconReceiptBill } from '@/ds/icons/central/IconReceiptBill';
import { TraceIcon } from '@/ds/icons/TraceIcon';
import { t as studioT, useLocale } from '@/lib/i18n';

export type ExperimentScorePanelProps = {
  /** Always mount the panel and pass `undefined` to close it, so the drawer can animate out. */
  score?: ClientScoreRowData;
  onNext?: () => void;
  onPrevious?: () => void;
  onClose: () => void;
  /** When provided, a Trace button appears in the header; hidden when `score.traceId` is absent. */
  onShowTrace?: () => void;
};

function isCodeBasedScorer(score: ClientScoreRowData): boolean {
  const scorer = score.scorer as Record<string, unknown> | undefined;
  if (scorer?.hasJudge === false) return true;
  if (scorer?.hasJudge === true) return false;
  return !score.preprocessPrompt && !score.analyzePrompt && !score.generateScorePrompt && !score.generateReasonPrompt;
}

export function ExperimentScorePanel({ score, onNext, onPrevious, onClose, onShowTrace }: ExperimentScorePanelProps) {
  useLocale();
  return (
    <DataPanel
      open={!!score}
      onClose={onClose}
      title={score ? studioT('Score {value0}', { value0: score.scorerId }) : studioT('Score')}
      depth={2}
    >
      {score && (
        <ExperimentScorePanelBody
          score={score}
          onNext={onNext}
          onPrevious={onPrevious}
          onClose={onClose}
          onShowTrace={onShowTrace}
        />
      )}
    </DataPanel>
  );
}

function ExperimentScorePanelBody({
  score,
  onNext,
  onPrevious,
  onClose,
  onShowTrace,
}: Omit<ExperimentScorePanelProps, 'score'> & { score: ClientScoreRowData }) {
  useLocale();
  const isCodeBased = isCodeBasedScorer(score);
  const naText = isCodeBased ? 'Not applicable (code-based scorer)' : 'Step not configured';

  return (
    <>
      <DataPanel.Header>
        <DataPanel.CloseButton onClick={onClose} tooltip={studioT('Close score panel')} />
        <DataPanel.Heading>
          {studioT('Score')}
          <DataPanel.CopyId id={score.scorerId} />
        </DataPanel.Heading>
        <DataPanel.HeaderActions>
          {onShowTrace && score.traceId && (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onShowTrace}
              tooltip={studioT('See trace')}
              aria-label={studioT('See trace')}
            >
              <TraceIcon />
            </Button>
          )}
          {(onPrevious || onNext) && (
            <DataPanel.NextPrevNav
              onPrevious={onPrevious}
              onNext={onNext}
              previousLabel={studioT('Go to previous score')}
              nextLabel={studioT('Go to next score')}
            />
          )}
        </DataPanel.HeaderActions>
      </DataPanel.Header>

      <DataPanel.Content>
        <div className="grid gap-3">
          <DataPanel.CodeSection
            title={studioT('Score: {value0}', { value0: score.score })}
            icon={<IconGauge />}
            codeStr={score.reason || naText}
            simplified
          />

          {!isCodeBased && (
            <>
              <DataPanel.CodeSection
                title={studioT('Preprocess Prompt')}
                icon={<IconReceiptBill />}
                codeStr={score.preprocessPrompt || naText}
                simplified
              />
              <DataPanel.CodeSection
                title={studioT('Analyze Prompt')}
                icon={<IconReceiptBill />}
                codeStr={score.analyzePrompt || naText}
                simplified
              />
              <DataPanel.CodeSection
                title={studioT('Generate Score Prompt')}
                icon={<IconReceiptBill />}
                codeStr={score.generateScorePrompt || naText}
                simplified
              />
              <DataPanel.CodeSection
                title={studioT('Generate Reason Prompt')}
                icon={<IconReceiptBill />}
                codeStr={score.generateReasonPrompt || naText}
                simplified
              />
            </>
          )}
        </div>
      </DataPanel.Content>
    </>
  );
}
