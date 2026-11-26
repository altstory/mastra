import type { LogRecord } from '../../types';
import { LogInsetSection } from './log-inset-section';
import { logLevelTextClass } from '@/ds/components/LogStream';
import { cn } from '@/lib/utils';
import { t as studioT, useLocale } from '@/lib/i18n';

export function LogDetailsSection({ log }: { log: LogRecord }) {
  useLocale();
  return (
    <LogInsetSection title={studioT('Details')}>
      <LogInsetSection.Row label={studioT('Level')}>
        <span className={cn('capitalize', logLevelTextClass[log.level])}>{log.level}</span>
      </LogInsetSection.Row>
      {log.entityType && <LogInsetSection.Row label={studioT('Entity type')}>{log.entityType}</LogInsetSection.Row>}
      {log.entityName && <LogInsetSection.Row label={studioT('Entity name')}>{log.entityName}</LogInsetSection.Row>}
      {log.serviceName && <LogInsetSection.Row label={studioT('Service')}>{log.serviceName}</LogInsetSection.Row>}
      {log.environment && <LogInsetSection.Row label={studioT('Environment')}>{log.environment}</LogInsetSection.Row>}
      {log.source && <LogInsetSection.Row label={studioT('Source')}>{log.source}</LogInsetSection.Row>}
    </LogInsetSection>
  );
}
