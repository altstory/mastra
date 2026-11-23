'use client';

import { Notice } from '@/ds/components/Notice';
import { Txt } from '@/ds/components/Txt';
import { t as studioT, useLocale } from '@/lib/i18n';

export interface ValidationError {
  row: number;
  column: string;
  message: string;
}

export interface ValidationSummaryProps {
  errors: ValidationError[];
}

/**
 * Displays validation errors found during CSV import.
 * Returns null if no errors.
 */
export function ValidationSummary({ errors }: ValidationSummaryProps) {
  useLocale();
  if (errors.length === 0) {
    return null;
  }

  return (
    <Notice
      variant="destructive"
      title={studioT('{value0} validation error{value1} found', {
        value0: errors.length,
        value1: errors.length !== 1 ? studioT('English plural suffix') : '',
      })}
    >
      <div className="max-h-[120px] space-y-1 overflow-y-auto">
        {errors.map((error: ValidationError, index: number) => (
          <Txt as="p" variant="body" key={index}>
            {studioT('Row') + ' '}
            {error.row}{' '}
            <Txt as="span" variant="subheading">
              [{error.column}]
            </Txt>
            : {error.message}
          </Txt>
        ))}
      </div>
    </Notice>
  );
}
