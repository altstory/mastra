import { playDoneSound, saveDoneSound, useDoneSound } from './done-sound';

import type { DoneSound } from './done-sound';
import { SettingsSubsection } from './settings-subsection';
import { SoundPicker } from './sound-picker';

import { ThemeToggle } from '@/ds/components/ThemeToggle';
import { SettingsContainer, SettingsRow } from '@/ds/new/settings';
import { t as studioT, useLocale } from '@/lib/i18n';

export function PreferencesSettings() {
  useLocale();
  const doneSound = useDoneSound();
  const changeDoneSound = (next: DoneSound) => {
    saveDoneSound(next);
    playDoneSound(next);
  };
  return (
    <SettingsSubsection
      scope="personal"
      title={studioT('Preferences')}
      description={studioT('Stored in this browser.')}
    >
      <SettingsContainer>
        <SettingsRow label={studioT('Theme')} description={studioT('Color scheme for the interface.')}>
          <ThemeToggle />
        </SettingsRow>
        <SettingsRow label={studioT('Completion sound')} description={studioT('Played when an agent run finishes.')}>
          <SoundPicker value={doneSound} onChange={changeDoneSound} />
        </SettingsRow>
      </SettingsContainer>
    </SettingsSubsection>
  );
}
