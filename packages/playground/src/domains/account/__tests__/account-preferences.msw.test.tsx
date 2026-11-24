import { useChatPreferences } from '@mastra/playground-ui/domains/chat';
import { act, waitFor, screen, fireEvent, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AccountChatPreferences } from '../account-chat-preferences';
import { AccountContext } from '../account-context';
import { installPreferenceFixture } from './fixtures/preferences';
import { creatorSession } from './fixtures/session';
import { useAgentMemoryPreferences } from '@/domains/agents/context/agent-memory-preferences';
import { makeWrapper, renderWithProviders } from '@/test/render';

function PreferencesProbe() {
  const { preferences, updatePreferences } = useChatPreferences();
  return <button onClick={() => updatePreferences({ fontSize: 20 })}>{JSON.stringify(preferences)}</button>;
}
function MemoryProbe() {
  const [preference, setPreference, status] = useAgentMemoryPreferences('creator-agent');
  return (
    <button disabled={status.isLoading} onClick={() => setPreference({ enabled: true })}>
      {JSON.stringify(preference)}
    </button>
  );
}

beforeEach(() => {
  localStorage.clear();
});

function renderAccountMemory() {
  const { wrapper: Providers } = makeWrapper();
  return renderHook(() => useAgentMemoryPreferences('creator-agent'), {
    wrapper: ({ children }) => (
      <Providers>
        <AccountContext.Provider value={creatorSession}>{children}</AccountContext.Provider>
      </Providers>
    ),
  });
}

describe('Account memory preferences', () => {
  describe('when the server has memory disabled', () => {
    it('restores the account choice in another browser without local storage', async () => {
      installPreferenceFixture({ 'memory:creator-agent': { enabled: false } });
      const first = renderAccountMemory();
      await waitFor(() => expect(first.result.current[0].enabled).toBe(false));
      first.unmount();
      localStorage.clear();
      const second = renderAccountMemory();
      await waitFor(() => expect(second.result.current[0].enabled).toBe(false));
      act(() => second.result.current[1]({ enabled: true }));
      await waitFor(() => expect(second.result.current[0].enabled).toBe(true));
      expect(localStorage.getItem('mastra-memory-preferences-local-creator-agent')).toBeNull();
    });
  });
});

describe('Account chat settings', () => {
  describe('when opening a fresh browser', () => {
    it('loads saved presentation and composer settings from the account', async () => {
      installPreferenceFixture({ 'chat:global': { fontSize: 18, sendShortcut: 'mod-enter', busyEnter: 'steer' } });
      const tree = (
        <AccountContext.Provider value={creatorSession}>
          <AccountChatPreferences scope="alice">
            <PreferencesProbe />
          </AccountChatPreferences>
        </AccountContext.Provider>
      );
      const first = renderWithProviders(tree);
      const button = await screen.findByRole('button', { name: /"fontSize":18/ });
      expect(button.textContent).toContain('"busyEnter":"steer"');
      fireEvent.click(button);
      await screen.findByRole('button', { name: /"fontSize":20/ });
      first.unmount();
      localStorage.clear();
      renderWithProviders(tree);
      expect(await screen.findByRole('button', { name: /"fontSize":20/ })).toBeTruthy();
      expect(localStorage.getItem('mastra:chat-preferences:v1:alice')).toBeNull();
    });
  });
  describe('when the server rejects a save', () => {
    it('keeps the saved memory setting and allows retry without writing a local substitute', async () => {
      const fixture = installPreferenceFixture({ 'memory:creator-agent': { enabled: false } });
      const view = renderAccountMemory();
      await waitFor(() => expect(view.result.current[0].enabled).toBe(false));
      fixture.fail(true);
      act(() => view.result.current[1]({ enabled: true }));
      await waitFor(() => expect(view.result.current[2].error?.message).toBe('Preferences unavailable'));
      expect(view.result.current[0].enabled).toBe(false);
      expect(localStorage.getItem('mastra-memory-preferences-local-creator-agent')).toBeNull();
      fixture.fail(false);
      act(() => view.result.current[2].retry());
      await waitFor(() => expect(view.result.current[2].error).toBeNull());
    });
  });
});

describe('Legacy account preference migration', () => {
  describe('when a previous browser copy exists', () => {
    it('keeps the backup on failure and imports only the signed-in account after retry', async () => {
      localStorage.setItem(
        'mastra-memory-preferences-alice-creator-agent',
        JSON.stringify({ enabled: false, workingMemory: false }),
      );
      localStorage.setItem('mastra-memory-preferences-bob-creator-agent', JSON.stringify({ enabled: true }));
      const fixture = installPreferenceFixture();
      fixture.fail(true);
      const view = renderWithProviders(
        <AccountContext.Provider value={creatorSession}>
          <AccountChatPreferences scope="alice">
            <MemoryProbe />
          </AccountChatPreferences>
        </AccountContext.Provider>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      expect(localStorage.getItem('mastra-memory-preferences-alice-creator-agent')).toBeTruthy();
      fixture.fail(false);
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      await screen.findByRole('button', { name: '{"enabled":false}' });
      expect(localStorage.getItem('mastra-memory-preferences-alice-creator-agent')).toBeNull();
      expect(localStorage.getItem('mastra-memory-preferences-bob-creator-agent')).toBeTruthy();
      const bob = { ...creatorSession, user: { ...creatorSession.user, id: 'bob' } };
      fixture.entries.set('memory:creator-agent', { value: { enabled: true }, revision: 2 });
      view.rerender(
        <AccountContext.Provider value={bob}>
          <AccountChatPreferences scope="bob">
            <MemoryProbe />
          </AccountChatPreferences>
        </AccountContext.Provider>,
      );
      await screen.findByRole('button', { name: '{"enabled":true}' });
    });
  });
});

describe('Local run form drafts', () => {
  describe('when switching accounts or servers', () => {
    it('does not reuse another scope or the old unattributed request parameters', async () => {
      const { BrowserDraftScopeContext, scopedDraftKey } =
        await import('@mastra/playground-ui/hooks/browser-draft-scope');
      const { useEntityRequestContext } =
        await import('@mastra/playground-ui/domains/request-context/hooks/use-entity-request-context');
      function DraftProbe() {
        const [value, setValue] = useEntityRequestContext('agent', 'creator-agent');
        return <button onClick={() => setValue({ note: 'Alice draft' })}>{JSON.stringify(value)}</button>;
      }
      const rawKey = 'mastra-request-context:agent:creator-agent';
      localStorage.setItem(rawKey, JSON.stringify({ note: 'Unattributed draft' }));
      const view = renderWithProviders(
        <BrowserDraftScopeContext.Provider value="server-a:alice">
          <DraftProbe />
        </BrowserDraftScopeContext.Provider>,
      );
      fireEvent.click(screen.getByRole('button', { name: '{}' }));
      expect(screen.getByRole('button', { name: '{"note":"Alice draft"}' })).toBeTruthy();
      expect(localStorage.getItem(scopedDraftKey(rawKey, 'server-a:alice'))).toBe('{"note":"Alice draft"}');
      view.rerender(
        <BrowserDraftScopeContext.Provider value="server-a:bob">
          <DraftProbe />
        </BrowserDraftScopeContext.Provider>,
      );
      expect(screen.getByRole('button', { name: '{}' })).toBeTruthy();
      view.rerender(
        <BrowserDraftScopeContext.Provider value="server-b:alice">
          <DraftProbe />
        </BrowserDraftScopeContext.Provider>,
      );
      expect(screen.getByRole('button', { name: '{}' })).toBeTruthy();
    });
  });
});
