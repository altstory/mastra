'use client';

import type { CsvValidationResult, RowValidationResult } from '../../utils/csv-validation';
import { InlineCode } from '@/ds/components/InlineCode';
import { Txt } from '@/ds/components/Txt';

import { IconCircleCheck } from '@/ds/icons/central/IconCircleCheck';
import { IconExclamationTriangle } from '@/ds/icons/central/IconExclamationTriangle';
import { t as studioT, useLocale } from '@/lib/i18n';
import { Trans } from '@/lib/i18n/trans';
import { cn } from '@/utils/cn';

interface ValidationReportProps {
  result: CsvValidationResult;
  className?: string;
}

/**
 * Shows validation results after schema validation of CSV rows.
 * Displays count of valid/invalid rows and a table of failures.
 */
export function ValidationReport({ result, className }: ValidationReportProps) {
  useLocale();
  const { validCount, invalidCount, totalRows, invalidRows } = result;

  // All rows valid
  if (invalidCount === 0) {
    return (
      <div className={cn('flex items-center gap-2 text-success-indicator', className)}>
        <IconCircleCheck className="size-icon-md" />
        <Txt as="span" variant="body" className="block">
          <Trans
            id="All {part0} row {part1} valid"
            values={{ part0: totalRows, part1: totalRows !== 1 ? studioT('English plural suffix') : '' }}
          />
        </Txt>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {/* Summary warning */}
      <div className="flex items-center gap-2 text-warning-foreground">
        <IconExclamationTriangle className="size-icon-md" />
        <Txt as="span" variant="body" className="block">
          <Trans
            id="{part0} of {part1} rows will be skipped (validation failed)"
            values={{ part0: invalidCount, part1: totalRows }}
          />
        </Txt>
      </div>

      {validCount > 0 && (
        <Txt as="p" variant="body" tone="muted">
          <Trans id="{part0} rows will be imported" values={{ part0: validCount }} />
        </Txt>
      )}

      {/* Failing rows table */}
      <div className="max-h-48 overflow-y-auto rounded-md border">
        <table className="w-full">
          <thead className="sticky top-0 bg-muted">
            <tr>
              <th className="px-2 py-1 text-left">
                <Txt as="span" variant="column" className="block">
                  {studioT('Row')}
                </Txt>
              </th>
              <th className="px-2 py-1 text-left">
                <Txt as="span" variant="column" className="block">
                  {studioT('Field')}
                </Txt>
              </th>
              <th className="px-2 py-1 text-left">
                <Txt as="span" variant="column" className="block">
                  {studioT('Error')}
                </Txt>
              </th>
            </tr>
          </thead>
          <tbody>
            {invalidRows.map((row: RowValidationResult, idx: number) => (
              <ValidationRow key={idx} row={row} />
            ))}
            {invalidCount > invalidRows.length && (
              <tr>
                <td colSpan={3} className="px-2 py-1 text-muted-foreground italic">
                  <Txt as="span" variant="caption" className="block">
                    <Trans id="... and {part0} more" values={{ part0: invalidCount - invalidRows.length }} />
                  </Txt>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Single row in the validation failure table.
 */
function ValidationRow({ row }: { row: RowValidationResult }) {
  const errorMessage = row.errors[0]?.message || 'Validation failed';
  const errorPath = row.errors[0]?.path || '/';

  return (
    <tr className="border-t">
      <td className="px-2 py-1 text-muted-foreground">{row.rowNumber}</td>
      <td className="px-2 py-1">
        <InlineCode className="rounded bg-muted px-1 text-caption">
          {row.field}
          {errorPath !== '/' ? errorPath : ''}
        </InlineCode>
      </td>
      <td className="px-2 py-1 text-destructive-foreground">{errorMessage}</td>
    </tr>
  );
}
