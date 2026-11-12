import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { all, buttonByLabel, textOf } from '../../../../test/dom';
import { UploadItem } from '../board-uploads';
import { BoardUploadPanel } from './board-upload-panel';

const item = (overrides: Partial<UploadItem> = {}): UploadItem => ({
  id: 1,
  name: 'photo.png',
  size: 2_500_000,
  progress: 0.4,
  status: 'uploading',
  ...overrides,
});

describe('BoardUploadPanel', () => {
  let fixture: ComponentFixture<BoardUploadPanel>;
  const items = signal<readonly UploadItem[]>([]);
  let cleared: number;

  async function render(list: UploadItem[]): Promise<void> {
    items.set(list);
    cleared = 0;
    fixture = TestBed.createComponent(BoardUploadPanel, {
      bindings: [inputBinding('items', items), outputBinding('cleared', () => cleared++)],
    });
    await fixture.whenStable();
  }

  describe('rendering', () => {
    it('when nothing is uploaded then the panel is not shown', async () => {
      await render([]);

      expect(all(fixture, '[data-testid=uploads]').length, 'panel').toBe(0);
    });

    it('when a file is uploading then its progress, size and the limits show and it cannot be closed', async () => {
      await render([item()]);

      expect(all<HTMLProgressElement>(fixture, 'progress')[0]?.value, 'percent').toBe(40);
      expect(textOf(fixture), 'size').toContain('2.5 MB');
      expect(textOf(fixture), 'limits').toContain('videos (MP4, WebM) up to 500 MB');
      expect(textOf(fixture), 'heading').toContain('Uploading');
      expect(all(fixture, 'button[aria-label="Close the upload list"]').length, 'no close').toBe(0);
    });

    it('when an upload failed then the reason and the request id show', async () => {
      await render([item({ status: 'failed', error: 'Too large.', requestId: 'req-9' })]);

      expect(all(fixture, '[role=alert]')[0]?.textContent, 'reason').toContain('Too large.');
      expect(textOf(fixture), 'request id').toContain('request req-9');
    });

    it('when everything is finished then the list can be closed', async () => {
      await render([item({ status: 'done', progress: 1 })]);

      buttonByLabel(fixture, 'Close the upload list').click();

      expect(textOf(fixture), 'done').toContain('Uploaded');
      expect(cleared, 'cleared').toBe(1);
    });
  });
});
