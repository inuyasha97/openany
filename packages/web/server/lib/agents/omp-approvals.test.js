import { describe, expect, it } from 'vitest';
import { createOmpApprovals } from './omp-approvals.js';

describe('createOmpApprovals', () => {
  it('broadcasts permission.asked for a confirm frame and records it', () => {
    const frames = [];
    const approvals = createOmpApprovals({ broadcast: (frame) => frames.push(frame) });

    expect(approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'ui_1', method: 'confirm', title: 'Run bash?', message: 'rm -rf build' })).toBe(true);

    expect(approvals.pending('ses_1')).toHaveLength(1);
    expect(frames[0].type).toBe('openchamber:omp');
    expect(frames[0].properties.events[0]).toMatchObject({
      type: 'permission.asked',
      properties: { id: 'ui_1', sessionID: 'ses_1', resources: ['rm -rf build'], message: 'Run bash?' },
    });
  });

  it('maps a reply to an extension_ui_response and broadcasts permission.replied', () => {
    const frames = [];
    const approvals = createOmpApprovals({ broadcast: (frame) => frames.push(frame) });
    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'ui_1', method: 'confirm', title: 't', message: 'm' });

    expect(approvals.resolve('ses_1', 'ui_1', 'once')).toEqual({ type: 'extension_ui_response', id: 'ui_1', confirmed: true });
    expect(approvals.resolve('ses_1', 'ui_2', 'reject')).toBeNull();
    expect(approvals.pending('ses_1')).toHaveLength(0);
    expect(frames[1].properties.events[0]).toMatchObject({
      type: 'permission.replied',
      properties: { sessionID: 'ses_1', requestID: 'ui_1' },
    });
  });

  it('maps reject to confirmed:false and select to a value', () => {
    const approvals = createOmpApprovals({ broadcast: () => {} });
    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'ui_1', method: 'confirm', title: 't', message: 'm' });
    expect(approvals.resolve('ses_1', 'ui_1', 'reject')).toEqual({ type: 'extension_ui_response', id: 'ui_1', confirmed: false });

    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'ui_2', method: 'select', title: 'Pick', options: ['a', 'b'] });
    expect(approvals.pending('ses_1')[0]).toMatchObject({ action: 'select', resources: ['a', 'b'] });
    expect(approvals.resolve('ses_1', 'ui_2', 'once', 'b')).toEqual({ type: 'extension_ui_response', id: 'ui_2', value: 'b' });
    expect(approvals.resolve('ses_1', 'ui_3', 'reject')).toBeNull();
  });

  it('ignores frames that are not questions', () => {
    const frames = [];
    const approvals = createOmpApprovals({ broadcast: (frame) => frames.push(frame) });

    expect(approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'ui_1', method: 'notify', message: 'hi' })).toBe(false);
    expect(approvals.handleRequest('ses_1', { type: 'agent_end' })).toBe(false);
    expect(frames).toEqual([]);
  });
});
