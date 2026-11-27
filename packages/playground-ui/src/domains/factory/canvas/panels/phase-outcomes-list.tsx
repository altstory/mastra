import type { PanelPhase, PanelPhaseOutcome } from './types';
import { Button } from '@/ds/components/Button';
import { Field, FieldError } from '@/ds/components/Field';
import { Input } from '@/ds/components/Input';
import { Notice } from '@/ds/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/ds/components/Select';
import { Txt } from '@/ds/components/Txt';
import { IconArrowRight } from '@/ds/icons/central/IconArrowRight';
import { IconPlusMedium } from '@/ds/icons/central/IconPlusMedium';
import { TrashIcon } from '@/ds/icons/TrashIcon';
import { t as studioT, useLocale } from '@/lib/i18n';

/** What the board's rules work out about a phase's outcomes, for the outcomes list. */
export interface PhaseOutcomesInfo {
  /** One per allowed move, as a phase that lists none offers them. */
  defaults: readonly PanelPhaseOutcome[];
  /** Why each of the phase's own outcomes can't save, by position. */
  problems: readonly { key?: string; label?: string }[];
  /** The next outcome a person adds; undefined when there is none to add. */
  added: PanelPhaseOutcome | undefined;
  /** The outcome the phase's exit tool reports when it succeeds; undefined when none is picked. */
  exitToolPick: PanelPhaseOutcome | undefined;
  /** The most outcomes a phase may list. */
  max: number;
}

/**
 * The outcomes the session working a card in this phase may report; Factory moves the card to the outcome's phase
 * when the run ends. A phase that lists none offers one per allowed move, shown until a person customizes them.
 */
export function PhaseOutcomesList({
  phase,
  phases,
  next,
  info,
  disabled,
  onChange,
}: {
  phase: PanelPhase;
  phases: readonly PanelPhase[];
  /** Where cards in this phase may go now. */
  next: readonly string[];
  info: PhaseOutcomesInfo;
  disabled: boolean;
  onChange: (outcomes: PanelPhaseOutcome[] | null) => void;
}) {
  useLocale();
  const own = phase.outcomes?.length ? phase.outcomes : undefined;
  const { defaults, problems, added, exitToolPick, max } = info;
  const nameOf = (key: string) => phases.find(other => other.key === key)?.name ?? key;

  if (next.length === 0) {
    return (
      <Txt as="p" variant="caption" tone="muted">
        {studioT('Allow a move first; each outcome goes to one of them.')}
      </Txt>
    );
  }

  const exitTool = phase.exitTool?.id;

  if (!own) {
    return (
      <div className="flex flex-col gap-2">
        <ul aria-label={studioT('{value0} outcomes', { value0: phase.name })} className="flex flex-col gap-1">
          {defaults.map(outcome => (
            <li key={outcome.key}>
              <Txt as="span" variant="caption" tone="muted">
                <code>{outcome.key}</code> {studioT('moves the card to')} {nameOf(outcome.to)}
              </Txt>
            </li>
          ))}
        </ul>
        {exitTool && <ExitToolNote exitTool={exitTool} picked={exitToolPick} phases={phases} />}
        <Txt as="p" variant="caption" tone="muted">
          {studioT(
            'The agent may report any allowed move by the key of the phase it goes to. Customize them to describe each one, or to offer fewer moves than people have.',
          )}
        </Txt>
        {!disabled && (
          <div>
            <Button size="sm" variant="ghost" onClick={() => onChange(defaults.slice(0, max))}>
              {studioT('Customize outcomes')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  const set = (index: number, patch: Partial<PanelPhaseOutcome>) =>
    onChange(own.map((outcome, other) => (other === index ? { ...outcome, ...patch } : outcome)));

  return (
    <div className="flex flex-col gap-2">
      <Txt as="p" variant="caption" tone="muted">
        {studioT(
          "The agent reports one by its key when its work is done; the description tells it when, and shows in the card's history.",
        )}
      </Txt>
      <ul aria-label={studioT('{value0} outcomes', { value0: phase.name })} className="flex flex-col gap-1.5">
        {own.map((outcome, index) => {
          const problem = problems[index] ?? {};
          const name = `outcome ${outcome.key || index + 1}`;
          return (
            <li key={index} className="flex flex-col gap-1.5 rounded-2xl bg-fill-subtle p-2">
              <div className="flex items-start gap-1.5">
                <Field invalid={Boolean(problem.key)} disabled={disabled} className="min-w-0 flex-1">
                  <Input
                    size="sm"
                    aria-label={studioT('{value0} outcome {value1} key', { value0: phase.name, value1: index + 1 })}
                    value={outcome.key}
                    placeholder={studioT('Key, e.g. review')}
                    disabled={disabled}
                    onChange={event => set(index, { key: event.target.value.trim() })}
                  />
                  {problem.key && <FieldError>{problem.key}</FieldError>}
                </Field>
                <IconArrowRight aria-hidden className="mt-2 size-icon-xs shrink-0 text-muted-foreground" />
                <Select
                  value={outcome.to}
                  disabled={disabled}
                  onValueChange={value => set(index, { to: String(value) })}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={studioT('{value0} {value1} goes to', { value0: phase.name, value1: name })}
                    className="w-24 shrink-0"
                  >
                    <span className="truncate">{nameOf(outcome.to)}</span>
                  </SelectTrigger>
                  <SelectContent>
                    {next.map(key => (
                      <SelectItem key={key} value={key}>
                        {nameOf(key)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!disabled && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    tooltip={studioT('Remove {value0}', { value0: name })}
                    onClick={() => {
                      const rest = own.filter((_, other) => other !== index);
                      onChange(rest.length > 0 ? rest : null);
                    }}
                  >
                    <TrashIcon />
                  </Button>
                )}
              </div>
              <Field invalid={Boolean(problem.label)} disabled={disabled}>
                <Input
                  size="sm"
                  aria-label={studioT('{value0} outcome {value1} label', { value0: phase.name, value1: index + 1 })}
                  value={outcome.label}
                  placeholder={studioT('Description, e.g. Change request opened')}
                  disabled={disabled}
                  onChange={event => set(index, { label: event.target.value })}
                />
                {problem.label && <FieldError>{problem.label}</FieldError>}
              </Field>
            </li>
          );
        })}
      </ul>
      {exitTool && <ExitToolNote exitTool={exitTool} picked={exitToolPick} phases={phases} />}
      {!disabled && (
        <div className="flex flex-wrap gap-1">
          {added && own.length < max && (
            <Button size="sm" variant="ghost" icon={<IconPlusMedium />} onClick={() => onChange([...own, added])}>
              {studioT('Add outcome')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            {studioT('Use one per move')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** What the phase's exit tool reports when it succeeds, or a warning that it picks no outcome. */
function ExitToolNote({
  exitTool,
  picked,
  phases,
}: {
  exitTool: string;
  picked: PanelPhaseOutcome | undefined;
  phases: readonly PanelPhase[];
}) {
  useLocale();
  if (!picked) {
    return (
      <Notice variant="warning">
        <Notice.Message>
          {studioT('When')} <code>{exitTool}</code>{' '}
          {studioT('succeeds, no outcome is picked, so the card waits for the agent to report one. Key an outcome')}{' '}
          <code>advance</code> {studioT('to choose where its success moves the card.')}
        </Notice.Message>
      </Notice>
    );
  }
  const to = phases.find(other => other.key === picked.to)?.name ?? picked.to;
  return (
    <Txt as="p" variant="caption" tone="muted">
      {studioT('When')} <code>{exitTool}</code> {studioT('succeeds, it reports')} <code>{picked.key}</code>
      {studioT(', moving the card to')} {to}.
    </Txt>
  );
}
