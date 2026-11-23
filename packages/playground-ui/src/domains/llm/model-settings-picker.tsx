import { useId, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ModelPickerPanel } from './model-picker-panel';
import type { ModelPickerProvider, ModelPickerValue } from './model-picker-types';
import { AlertDialog } from '@/ds/components/AlertDialog';
import { Button } from '@/ds/components/Button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ds/components/Popover';
import { Switch } from '@/ds/components/Switch';
import { Txt } from '@/ds/components/Txt';
import { IconArrowLeft } from '@/ds/icons/central/IconArrowLeft';
import { IconCheckmark2Medium } from '@/ds/icons/central/IconCheckmark2Medium';
import { IconChevronDownMedium } from '@/ds/icons/central/IconChevronDownMedium';
import { IconChevronRightMedium } from '@/ds/icons/central/IconChevronRightMedium';
import { menuItemButtonClass } from '@/ds/primitives/menu-item';
import { t, useLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { formatModelName } from '@/utils/model';

export interface ModelSettingsPickerProps {
  providers: ModelPickerProvider[];
  modelLocked?: boolean;
  reasoningLocked?: boolean;
  value?: ModelPickerValue;
  onValueChange: (value: ModelPickerValue) => void;
  defaultModel?: ModelPickerValue;
  reset?: { label: string; onClick: () => void };
  teamwork?: { enabled: boolean; hasMessages?: boolean; onChange: (enabled: boolean) => void };
  reasoning?: { levels: string[]; value: string; onChange: (level: string) => void };
}

const noProviderIcon = () => undefined;
const levelName = (level: string) => {
  switch (level) {
    case 'off':
      return 'Off';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'max':
      return 'Max';
    case 'minimal':
      return 'Minimal';
    case 'xhigh':
      return 'Extra high';
    default:
      return level;
  }
};

// Native buttons keep Enter/Space and Tab behavior; arrows also move through each pane.
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  const current = buttons.findIndex(button => button === document.activeElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[next]?.focus();
}

function focusPane(element: HTMLDivElement | null) {
  element?.querySelector<HTMLElement>('input, button')?.focus();
}

/** Click through model and reasoning panes, with no provider marks or hover menus. */
export function ModelSettingsPicker({
  providers,
  modelLocked = false,
  reasoningLocked = modelLocked,
  value,
  onValueChange,
  defaultModel,
  reset,
  reasoning,
  teamwork,
}: ModelSettingsPickerProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<'root' | 'model' | 'reasoning' | 'teamwork'>('root');
  const [confirmTeamOff, setConfirmTeamOff] = useState(false);
  const teamworkId = useId();
  const teamworkDescriptionId = useId();
  const selected = providers
    .find(provider => provider.id === value?.provider)
    ?.models.find(model => model.id === value?.model);
  const name = selected?.name ?? (value?.model ? formatModelName(value.model) : t('Select model'));
  const close = () => setOpen(false);
  const rowClass = menuItemButtonClass;

  return (
    <>
      <Popover
        open={open}
        onOpenChange={next => {
          setOpen(next);
          if (next) setPane('root');
        }}
      >
        <PopoverTrigger
          variant="ghost"
          size="sm"
          className="max-w-64 min-w-0 gap-1.5"
          aria-label={`${t('Model:')} ${name}${reasoning ? ` ${levelName(reasoning.value)}` : ''}`}
        >
          <span className="truncate">{name}</span>
          {reasoning && <span className="shrink-0 text-muted-foreground">{levelName(reasoning.value)}</span>}
          <IconChevronDownMedium aria-hidden className="size-icon-xs shrink-0" />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          className={cn(
            'max-w-[calc(100vw-2rem)] p-1',
            pane === 'model' ? 'w-80' : pane === 'reasoning' ? 'w-56' : 'w-72',
          )}
          aria-label={t('Model and reasoning level')}
        >
          {pane === 'root' ? (
            <div key="root" ref={focusPane} onKeyDown={moveFocus}>
              <button
                type="button"
                className={rowClass}
                aria-label={`${t('Model')} ${name}`}
                disabled={modelLocked}
                onClick={() => setPane('model')}
              >
                <span>{t('Model')}</span>
                <span className="ml-auto truncate text-muted-foreground">{name}</span>
                <IconChevronRightMedium aria-hidden className="size-icon-sm shrink-0" />
              </button>
              {reasoning && !reasoningLocked && (
                <button type="button" className={rowClass} onClick={() => setPane('reasoning')}>
                  <span>{t('Reasoning level')}</span>
                  <span className="ml-auto text-muted-foreground">{levelName(reasoning.value)}</span>
                  <IconChevronRightMedium aria-hidden className="size-icon-sm shrink-0" />
                </button>
              )}
              {teamwork && (
                <button type="button" className={rowClass} onClick={() => setPane('teamwork')}>
                  <span>{t('Agent teamwork')}</span>
                  <span className="ml-auto text-muted-foreground">{teamwork.enabled ? t('On') : t('Off')}</span>
                  <IconChevronRightMedium aria-hidden className="size-icon-sm shrink-0" />
                </button>
              )}
            </div>
          ) : (
            <div key={pane} ref={focusPane}>
              <Button
                variant="ghost"
                size="sm"
                className="mb-1 w-full justify-start"
                onClick={() => setPane('root')}
                aria-label={t('Back to model settings')}
              >
                <IconArrowLeft aria-hidden />
                {pane === 'model' ? t('Model') : pane === 'teamwork' ? t('Agent teamwork') : t('Reasoning level')}
              </Button>
              {pane === 'teamwork' && teamwork ? (
                <div className="flex min-w-0 flex-col">
                  <label htmlFor={teamworkId} className={cn(rowClass, 'cursor-pointer justify-between gap-4')}>
                    <Txt as="span" variant="menu">
                      {t('Enable agent teamwork')}
                    </Txt>
                    <Switch
                      id={teamworkId}
                      aria-label={t('Enable agent teamwork')}
                      aria-describedby={teamworkDescriptionId}
                      checked={teamwork.enabled}
                      onCheckedChange={enabled => {
                        if (!enabled && teamwork.hasMessages) setConfirmTeamOff(true);
                        else teamwork.onChange(enabled);
                      }}
                    />
                  </label>
                  <Txt id={teamworkDescriptionId} variant="caption" tone="muted" className="px-2 py-1">
                    {t('Enable shared tasks and coordination instructions. Sub-agents remain available when disabled.')}
                  </Txt>
                </div>
              ) : pane === 'model' ? (
                <ModelPickerPanel
                  providers={providers}
                  value={value}
                  defaultModel={defaultModel}
                  onSelect={next => {
                    onValueChange(next);
                    close();
                  }}
                  renderProviderIcon={noProviderIcon}
                  reset={
                    reset && {
                      label: reset.label,
                      onClick: () => {
                        reset.onClick();
                        close();
                      },
                    }
                  }
                  sheet={false}
                  preserveOrder
                  onAddProvider={close}
                />
              ) : (
                reasoning && (
                  <div role="listbox" aria-label={t('Reasoning level')} onKeyDown={moveFocus}>
                    {reasoning.levels.map(level => (
                      <button
                        key={level}
                        type="button"
                        role="option"
                        aria-selected={level === reasoning.value}
                        className={rowClass}
                        onClick={() => {
                          reasoning.onChange(level);
                          close();
                        }}
                      >
                        <span>{levelName(level)}</span>
                        {level === reasoning.value && <IconCheckmark2Medium aria-hidden className="ml-auto" />}
                      </button>
                    ))}
                  </div>
                )
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
      <AlertDialog open={confirmTeamOff} onOpenChange={setConfirmTeamOff}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('Turn off agent teamwork?')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('Shared tasks and agents are kept. Running sub-agents continue working.')}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('Cancel')}</AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={() => {
                teamwork?.onChange(false);
                setConfirmTeamOff(false);
              }}
            >
              {t('Turn off')}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </>
  );
}
