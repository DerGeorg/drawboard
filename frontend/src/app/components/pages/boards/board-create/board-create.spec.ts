import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { buttonByText } from '../../../../test/dom';
import { RecordedSpans, recordSpans } from '../../../../test/tracing';
import { BoardCreate } from './board-create';

describe('BoardCreate', () => {
  let fixture: ComponentFixture<BoardCreate>;
  const variant = signal<'card' | 'button'>('card');
  const requested = vi.fn();

  async function render(): Promise<void> {
    fixture = TestBed.createComponent(BoardCreate, {
      bindings: [inputBinding('variant', variant), outputBinding('requested', requested)],
    });
    await fixture.whenStable();
  }

  beforeEach(() => {
    variant.set('card');
    requested.mockClear();
  });

  describe('request', () => {
    it.each(['card', 'button'] as const)(
      'when the %s is clicked then the dialog is requested and nothing is created',
      async (kind) => {
        variant.set(kind);
        await render();

        buttonByText(fixture, 'New board').click();

        expect(requested, 'requested').toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('tracing', () => {
    let spans: RecordedSpans;

    beforeEach(() => {
      spans = recordSpans();
    });

    afterEach(() => spans.stop());

    it('when the button is clicked then a BoardCreate.request span is recorded', async () => {
      await render();

      buttonByText(fixture, 'New board').click();

      expect(spans.byName('BoardCreate.request'), 'span').toBeDefined();
    });
  });
});
