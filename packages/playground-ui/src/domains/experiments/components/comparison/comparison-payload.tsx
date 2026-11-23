import { CodeEditor } from '@/ds/components/CodeEditor';
import { MarkdownRenderer } from '@/ds/components/MarkdownRenderer';
import { t as studioT, useLocale } from '@/lib/i18n';

export interface ComparisonPayloadProps {
  value: unknown;
}

/** A payload (input, ground truth, output): strings as markdown, anything else as JSON. Frame it with a `framed` `ComparisonSection`. */
export function ComparisonPayload({ value }: ComparisonPayloadProps) {
  useLocale();
  return (
    <div className="min-w-0 p-3 text-foreground">
      {typeof value === 'string' ? (
        <MarkdownRenderer>{value}</MarkdownRenderer>
      ) : (
        <CodeEditor
          value={JSON.stringify(value ?? null, null, 2)}
          language="json"
          editable={false}
          lineNumbers={false}
          showCopyButton={false}
          variant="embedded"
          aria-label={studioT('JSON payload')}
        />
      )}
    </div>
  );
}
