import { createContext, useContext } from 'react';
import type { AccountSession } from './account-api';

export const AccountContext = createContext<AccountSession | undefined>(undefined);
export const useAccount = () => useContext(AccountContext);
export const useIsManagedAccount = () => {
  const account = useAccount();
  return !!account && account.user.role !== 'admin';
};
export const AccountSignOutContext = createContext<(() => Promise<void>) | undefined>(undefined);
export const useAccountSignOut = () => useContext(AccountSignOutContext);
