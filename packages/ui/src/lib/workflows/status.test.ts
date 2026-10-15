import { describe, expect, it } from 'bun:test';
import { describeRunStatus, describeStepStatus } from './status';

const t = (key: string) => key;

describe('describeStepStatus', () => {
  it('separates a person deciding from a failure', () => {
    expect(describeStepStatus('waiting_confirm', t).tone).toBe('attention');
    expect(describeStepStatus('needs_work', t).tone).toBe('attention');
    expect(describeStepStatus('blocked', t).tone).toBe('attention');
    expect(describeStepStatus('failed', t).tone).toBe('danger');
    expect(describeStepStatus('interrupted', t).tone).toBe('danger');
  });

  it('marks what is running and what is finished', () => {
    expect(describeStepStatus('running', t).tone).toBe('active');
    expect(describeStepStatus('done', t).tone).toBe('done');
    expect(describeStepStatus('pending', t).tone).toBe('neutral');
    expect(describeStepStatus('skipped', t).tone).toBe('neutral');
  });

  it('gives every status a label and an icon, so color is never the only signal', () => {
    for (const status of ['pending', 'running', 'waiting_confirm', 'needs_work', 'done', 'failed', 'skipped', 'blocked', 'interrupted'] as const) {
      const described = describeStepStatus(status, t);
      expect(described.label.length).toBeGreaterThan(0);
      expect(described.icon).toBeTruthy();
      expect(described.className).toContain('text-');
    }
  });
});

describe('describeRunStatus', () => {
  it('distinguishes waiting from running', () => {
    expect(describeRunStatus('waiting', t).tone).toBe('attention');
    expect(describeRunStatus('running', t).tone).toBe('active');
    expect(describeRunStatus('done', t).tone).toBe('done');
    expect(describeRunStatus('cancelled', t).tone).toBe('neutral');
  });
});
