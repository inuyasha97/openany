import { beforeEach, describe, expect, test } from 'bun:test';

import type { TodoState } from '@/lib/agent/events';
import { useTodoStore } from './useTodoStore';

const list: TodoState = { title: 'Ship', items: [{ phase: 'P', text: 'a', status: 'done' }] };
const other: TodoState = { title: 'Review', items: [{ phase: 'P', text: 'b', status: 'pending' }] };

describe('useTodoStore', () => {
  beforeEach(() => {
    useTodoStore.setState({ bySession: new Map() });
  });

  test('keeps one list per session', () => {
    useTodoStore.getState().apply('s1', list);
    expect(useTodoStore.getState().bySession.get('s1')).toEqual(list);
    expect(useTodoStore.getState().bySession.get('s2')).toBeUndefined();
  });

  test('a null update clears the session entry', () => {
    useTodoStore.getState().apply('s1', list);
    useTodoStore.getState().apply('s1', null);
    expect(useTodoStore.getState().bySession.has('s1')).toBe(false);
  });

  test('a failed load keeps the list that was already known', async () => {
    useTodoStore.getState().apply('s1', list);
    await useTodoStore.getState().load('s1', {
      fetchTodo: async () => {
        throw new Error('offline');
      },
    });
    expect(useTodoStore.getState().bySession.get('s1')).toEqual(list);
  });

  test('a load that answers replaces the list', async () => {
    useTodoStore.getState().apply('s1', list);
    await useTodoStore.getState().load('s1', { fetchTodo: async () => other });
    expect(useTodoStore.getState().bySession.get('s1')).toEqual(other);
  });
});
