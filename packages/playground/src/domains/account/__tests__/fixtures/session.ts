import type { AccountSession } from '../../account-api';
export const creatorSession: AccountSession = {
  user: { id: 'alice', name: 'Alice', role: 'creator', email: 'alice@example.test' },
  permissions: ['agents:read', 'agents:execute', 'memory:read', 'memory:write'],
  resourceId: 'altflow:alice',
};
export const adminSession: AccountSession = {
  user: { id: 'admin', name: 'Admin', role: 'admin' },
  permissions: ['*'],
  resourceId: 'altflow:admin',
};
