import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { TodoState } from '@/lib/agent/events';
import { TodoChecklist } from './TodoChecklist';

const todo: TodoState = {
    title: 'Ship the parity work',
    items: [
        { phase: 'Evidence', text: 'check the store', status: 'done' },
        { phase: 'Evidence', text: 'map the frame', status: 'in_progress' },
        { phase: 'Fix', text: 'write the row', status: 'pending' },
    ],
};

describe('TodoChecklist', () => {
    test('renders each item under its phase, with a mark per status', () => {
        const html = renderToStaticMarkup(<TodoChecklist todo={todo} />);

        expect(html).toContain('check the store');
        expect(html).toContain('map the frame');
        expect(html).toContain('write the row');
        // The phase is a heading for its items, not a label per item.
        expect(html.match(/Evidence/g)?.length).toBe(1);
        expect(html).toContain('Fix');
        // Done reads as struck through; the others do not.
        expect(html.match(/line-through/g)?.length).toBe(1);
        expect(html).toContain('checkbox-circle');
        expect(html).toContain('checkbox-blank');
        expect(html).toContain('loader');
    });
});
