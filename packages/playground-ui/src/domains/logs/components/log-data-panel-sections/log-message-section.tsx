import { DataPanel } from '@/ds/components/DataPanel';
import { t as studioT, useLocale } from '@/lib/i18n';

function prettyJsonObject(message: string): string | undefined {
  if (!message.trim().startsWith('{')) return undefined;
  try {
    return JSON.stringify(JSON.parse(message), null, 2);
  } catch {
    return undefined;
  }
}

export function LogMessageSection({ message }: { message: string }) {
  useLocale();
  const json = prettyJsonObject(message);
  if (json === undefined) return <DataPanel.CodeSection title={studioT('Message')} codeStr={message} simplified />;
  return <DataPanel.CodeSection title={studioT('Message')} codeStr={json} />;
}
