import { afterEach, expect, test, vi } from 'vitest';
import { getSyncQueue } from '../../src/services/syncQueueService';
import { submitPersonForm } from '../../src/services/personService';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('offline registration binds the draft to its store and user', async () => {
  vi.useFakeTimers();
  const values = new Map<string,string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { sessionStorage: storage, dispatchEvent: () => true });
  vi.stubGlobal('navigator', { onLine: false });
  storage.setItem('activeStoreId', 'A');
  storage.setItem('auth_user', JSON.stringify({id:'one'}));
  const draft = await submitPersonForm({name:'آزمون'});
  expect(draft.isLocalUnsynced).toBe(true);
  expect(getSyncQueue()[0].payload.id).toBe(draft.id);
  storage.setItem('activeStoreId', 'B');
  expect(getSyncQueue()).toEqual([]);
  storage.setItem('activeStoreId', 'A');
  storage.setItem('auth_user', JSON.stringify({id:'two'}));
  expect(getSyncQueue()).toEqual([]);
  storage.setItem('auth_user', JSON.stringify({id:'one'}));
  expect(getSyncQueue()).toHaveLength(1);
});
