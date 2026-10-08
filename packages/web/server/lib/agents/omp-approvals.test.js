import { describe, expect, it, vi } from 'vitest';
import { createOmpApprovals } from './omp-approvals.js';

const asked = (frames, type) => frames.filter((frame) => frame.properties.events[0].type === type);

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

  it('maps reject to confirmed:false and keeps input as a permission', () => {
    const approvals = createOmpApprovals({ broadcast: () => {} });
    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'ui_1', method: 'confirm', title: 't', message: 'm' });
    expect(approvals.resolve('ses_1', 'ui_1', 'reject')).toEqual({ type: 'extension_ui_response', id: 'ui_1', confirmed: false });

    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'ui_2', method: 'input', title: 'Paste the code' });
    expect(approvals.pending('ses_1')[0]).toMatchObject({ action: 'input', resources: [], message: 'Paste the code' });
    expect(approvals.resolve('ses_1', 'ui_2', 'once', '1234')).toEqual({ type: 'extension_ui_response', id: 'ui_2', value: '1234' });
    expect(approvals.forms('ses_1')).toEqual([]);
  });

  it('projects a select frame as a form request with its options', () => {
    const frames = [];
    const approvals = createOmpApprovals({ broadcast: (frame) => frames.push(frame) });

    expect(approvals.handleRequest('ses_1', {
      type: 'extension_ui_request',
      id: 'r1',
      method: 'select',
      title: 'Which one?',
      options: ['a', 'b'],
      optionDetails: [{ description: 'first' }, {}],
    })).toBe(true);

    expect(approvals.forms('ses_1')).toEqual([
      {
        id: 'r1',
        sessionID: 'ses_1',
        title: 'Which one?',
        fields: [{
          key: 'value',
          type: 'string',
          title: 'Which one?',
          options: [
            { value: 'a', label: 'a', description: 'first' },
            { value: 'b', label: 'b' },
          ],
        }],
      },
    ]);
    expect(approvals.pending('ses_1')).toEqual([]);
    expect(asked(frames, 'form.created')[0].properties.events[0].properties.form.title).toBe('Which one?');
  });

  it('projects an editor frame as a free-text form field', () => {
    const approvals = createOmpApprovals({ broadcast: () => {} });
    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'r1', method: 'editor', title: 'Why?', prefill: 'because' });

    expect(approvals.forms('ses_1')).toEqual([
      {
        id: 'r1',
        sessionID: 'ses_1',
        title: 'Why?',
        fields: [{ key: 'value', type: 'string', title: 'Why?', default: 'because' }],
      },
    ]);
  });

  it('answers a form with its value and tells the UI it settled', () => {
    const frames = [];
    const approvals = createOmpApprovals({ broadcast: (frame) => frames.push(frame) });
    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'r1', method: 'select', title: '?', options: ['a'] });

    expect(approvals.resolveForm('ses_1', 'r1', 'a')).toEqual({ type: 'extension_ui_response', id: 'r1', value: 'a' });
    expect(approvals.forms('ses_1')).toEqual([]);
    expect(asked(frames, 'form.settled')[0].properties.events[0]).toMatchObject({
      type: 'form.settled',
      properties: { sessionID: 'ses_1', formID: 'r1' },
    });
  });

  it('cancels a form and answers the frame with cancelled:true', () => {
    const approvals = createOmpApprovals({ broadcast: () => {} });
    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'r1', method: 'select', title: '?', options: ['a'] });

    expect(approvals.cancelForm('ses_1', 'r1')).toEqual({ type: 'extension_ui_response', id: 'r1', cancelled: true });
    expect(approvals.cancelForm('ses_1', 'r1')).toBeNull();
    expect(approvals.forms('ses_1')).toEqual([]);
  });

  it('never crosses the two surfaces', () => {
    const approvals = createOmpApprovals({ broadcast: () => {} });
    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'ui_1', method: 'confirm', title: 't', message: 'm' });
    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'r1', method: 'select', title: '?', options: ['a'] });

    expect(approvals.resolveForm('ses_1', 'ui_1', 'a')).toBeNull();
    expect(approvals.cancelForm('ses_1', 'ui_1')).toBeNull();
    expect(approvals.resolve('ses_1', 'r1', 'once', 'a')).toBeNull();
    // A refusal must not have dropped the recorded asks.
    expect(approvals.pending('ses_1')).toHaveLength(1);
    expect(approvals.forms('ses_1')).toHaveLength(1);
  });

  it('drops the pending ask when OMP cancels it by target id', () => {
    const frames = [];
    const approvals = createOmpApprovals({ broadcast: (frame) => frames.push(frame) });
    approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'r1', method: 'select', title: '?', options: ['a'] });

    expect(approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'c1', method: 'cancel', targetId: 'r1' })).toBe(true);

    expect(approvals.forms('ses_1')).toEqual([]);
    expect(approvals.resolveForm('ses_1', 'r1', 'a')).toBeNull();
    expect(asked(frames, 'form.settled')).toHaveLength(1);
  });

  it('drops a timed-out ask and settles it for the UI', () => {
    vi.useFakeTimers();
    try {
      const frames = [];
      const approvals = createOmpApprovals({ broadcast: (frame) => frames.push(frame) });
      approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'r1', method: 'select', title: '?', options: ['a'], timeout: 5000 });

      vi.advanceTimersByTime(4999);
      expect(approvals.forms('ses_1')).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(approvals.forms('ses_1')).toEqual([]);
      expect(asked(frames, 'form.settled')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a session\'s asks and their timeouts on forget', () => {
    vi.useFakeTimers();
    try {
      const frames = [];
      const approvals = createOmpApprovals({ broadcast: (frame) => frames.push(frame) });
      approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'r1', method: 'select', title: '?', options: ['a'], timeout: 5000 });

      approvals.forget('ses_1');
      vi.advanceTimersByTime(5000);

      expect(approvals.forms('ses_1')).toEqual([]);
      expect(frames).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores frames that are not questions', () => {
    const frames = [];
    const approvals = createOmpApprovals({ broadcast: (frame) => frames.push(frame) });

    expect(approvals.handleRequest('ses_1', { type: 'extension_ui_request', id: 'ui_1', method: 'notify', message: 'hi' })).toBe(false);
    expect(approvals.handleRequest('ses_1', { type: 'agent_end' })).toBe(false);
    expect(frames).toEqual([]);
  });
});
