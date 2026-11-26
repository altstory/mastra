import { useCallback, useState } from 'react';
import { MAX_IMPORT_LABEL } from '../../utils/json-validation';
import type { JSONImportValidation, JSONPreviewRow } from '../../utils/json-validation';
import { Badge } from '@/ds/components/Badge';
import { Button } from '@/ds/components/Button';
import { CodeEditor } from '@/ds/components/CodeEditor';
import { Tab, TabContent, TabList, Tabs } from '@/ds/components/Tabs';
import { Txt } from '@/ds/components/Txt';
import { IconArrowOutOfBox } from '@/ds/icons/central/IconArrowOutOfBox';
import { IconArrowRotateClockwise } from '@/ds/icons/central/IconArrowRotateClockwise';
import { IconFileText } from '@/ds/icons/central/IconFileText';
import { t as studioT, useLocale } from '@/lib/i18n';
import { Trans } from '@/lib/i18n/trans';
import { cn } from '@/utils/cn';

export type JSONSourceTab = 'upload' | 'paste';

export interface JSONSourceFile {
  name: string;
  size: number;
}

export interface JSONSourcePanelProps {
  tab: JSONSourceTab;
  onTabChange: (tab: JSONSourceTab) => void;
  file: JSONSourceFile | null;
  onFileSelect: (file: File) => void;
  onReplace: () => void;
  pastedText: string;
  onPastedTextChange: (text: string) => void;
  validation: JSONImportValidation;
  isImporting: boolean;
}

const PREVIEW_ROW_COUNT = 10;
const PASTE_PLACEHOLDER = `[
  { "input": "…", "groundTruth": "…" }
]`;

const tabContentClassName = 'flex min-h-0 flex-1 flex-col py-0';

export function JSONSourcePanel({
  tab,
  onTabChange,
  file,
  onFileSelect,
  onReplace,
  pastedText,
  onPastedTextChange,
  validation,
  isImporting,
}: JSONSourcePanelProps) {
  useLocale();
  return (
    <Tabs value={tab} defaultTab="upload" onValueChange={onTabChange} className="flex h-full flex-col gap-3">
      <TabList variant="pill">
        <Tab value="upload">{studioT('Upload file')}</Tab>
        <Tab value="paste">{studioT('Paste JSON')}</Tab>
      </TabList>

      <TabContent value="upload" className={tabContentClassName}>
        {file ? (
          <FileCard file={file} validation={validation} onReplace={onReplace} isImporting={isImporting} />
        ) : (
          <Dropzone onFileSelect={onFileSelect} disabled={isImporting} />
        )}
      </TabContent>

      <TabContent value="paste" className={tabContentClassName}>
        <CodeEditor
          aria-label={studioT('JSON items')}
          language="json"
          lineNumbers={false}
          showCopyButton={false}
          placeholder={PASTE_PLACEHOLDER}
          value={pastedText}
          onChange={onPastedTextChange}
          editable={!isImporting}
          className="min-h-50 flex-1"
        />
      </TabContent>
    </Tabs>
  );
}

function Dropzone({ onFileSelect, disabled }: { onFileSelect: (file: File) => void; disabled: boolean }) {
  useLocale();
  const [isDragOver, setIsDragOver] = useState(false);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0];
      if (selected) {
        onFileSelect(selected);
      }
      // Reset input so the same file can be selected again
      e.target.value = '';
    },
    [onFileSelect],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (disabled) return;

      const dropped = e.dataTransfer.files?.[0];
      if (dropped) {
        onFileSelect(dropped);
      }
    },
    [disabled, onFileSelect],
  );

  return (
    <div
      data-testid="json-dropzone"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'relative flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-card px-4 py-6 text-center',
        'hover:border-success-edge hover:bg-success-subtle',
        isDragOver && 'border-success-edge bg-success-subtle',
        disabled && 'cursor-wait opacity-60',
      )}
    >
      <input
        type="file"
        accept=".json,application/json"
        aria-label={studioT('Choose a JSON file')}
        onChange={handleFileChange}
        disabled={disabled}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
      <div className="flex size-9 items-center justify-center rounded-md bg-nested text-muted-foreground">
        <IconArrowOutOfBox className="size-icon-md" />
      </div>
      <div className="flex flex-col gap-1">
        <Txt tone="ink">{studioT('Drop a JSON file here')}</Txt>
        <Txt variant="caption" tone="muted">
          <Trans
            id="or {part0} from your computer"
            values={{ part0: <span className="underline">{studioT('choose a file')}</span> }}
          />
        </Txt>
      </div>
      <Txt variant="meta" tone="muted">
        <Trans id=".json files containing an array of items, up to {part0}" values={{ part0: MAX_IMPORT_LABEL }} />
      </Txt>
    </div>
  );
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatInput(input: unknown) {
  return typeof input === 'string' ? input : (JSON.stringify(input) ?? '');
}

function FileCard({
  file,
  validation,
  onReplace,
  isImporting,
}: {
  file: JSONSourceFile;
  validation: JSONImportValidation;
  onReplace: () => void;
  isImporting: boolean;
}) {
  useLocale();
  const rows: JSONPreviewRow[] = 'rows' in validation ? validation.rows : [];
  const total = 'total' in validation ? validation.total : 0;
  const visibleRows = rows.slice(0, PREVIEW_ROW_COUNT);

  return (
    <div data-testid="json-file-card" className="rounded-lg border border-border">
      <div className="flex items-center gap-2 px-3 py-2">
        <IconFileText className="size-icon-md shrink-0 text-muted-foreground" />
        <Txt as="span" variant="caption" tone="ink" font="mono" className="min-w-0 flex-1 truncate">
          {file.name}
        </Txt>
        <Txt as="span" variant="meta" tone="muted" className="shrink-0">
          {formatFileSize(file.size)}
        </Txt>
        <Button
          icon={<IconArrowRotateClockwise />}
          variant="ghost"
          size="sm"
          onClick={onReplace}
          disabled={isImporting}
        >
          {studioT('Replace')}
        </Button>
      </div>

      {visibleRows.map(row => (
        <div
          key={row.index}
          className="grid grid-cols-[2rem_1fr_auto] items-center gap-2 border-t border-border px-3 py-1.5"
        >
          <Txt as="span" variant="meta" tone="muted">
            {row.index}
          </Txt>
          <Txt as="span" variant="caption" tone="ink" font="mono" className="truncate">
            {formatInput(row.input)}
          </Txt>
          {!row.hasInput ? (
            <Badge variant="destructive" size="xs">
              {studioT('no input')}
            </Badge>
          ) : !row.hasGroundTruth ? (
            <Badge variant="warning" size="xs">
              {studioT('no groundTruth')}
            </Badge>
          ) : null}
        </div>
      ))}

      {total > PREVIEW_ROW_COUNT && (
        <Txt as="p" variant="meta" tone="muted" className="border-t border-border px-3 py-1.5">
          <Trans id="+ {part0} more" values={{ part0: total - PREVIEW_ROW_COUNT }} />
        </Txt>
      )}
    </div>
  );
}
