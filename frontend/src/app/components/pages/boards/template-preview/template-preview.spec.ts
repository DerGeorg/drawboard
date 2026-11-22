import { ComponentFixture, TestBed } from '@angular/core/testing';
import { inputBinding, signal } from '@angular/core';

import type { BoardFile } from '@apps/drawboard-engine';
import { Theme } from '../../../../services/theme';
import { all } from '../../../../test/dom';
import { TemplatePreview } from './template-preview';

const file = (blocks: BoardFile['blocks']): BoardFile => ({
  schemaVersion: 1,
  title: 'T',
  blocks,
  connectors: [],
  strokes: [],
});

const frame = (id: string, x: number): BoardFile['blocks'][number] => ({
  id,
  type: 'core.frame',
  x,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  z: 0,
  parent: null,
  locked: false,
  props: { fill: '#ecfdf5' },
  text: id,
});

describe('TemplatePreview', () => {
  const source = signal(file([frame('a', 0), frame('b', 120)]));
  let fixture: ComponentFixture<TemplatePreview>;

  beforeEach(async () => {
    source.set(file([frame('a', 0), frame('b', 120)]));
    fixture = TestBed.createComponent(TemplatePreview, {
      bindings: [inputBinding('file', source)],
    });
    await fixture.whenStable();
  });

  afterEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  describe('theme', () => {
    it('when the theme is dark then a white frame is drawn dark, a pastel one stays and the outline is soft', async () => {
      source.set(file([{ ...frame('a', 0), props: { fill: '#ffffff' } }, frame('b', 120)]));

      await TestBed.inject(Theme).set('DARK');
      await fixture.whenStable();

      const boxes = all(fixture, 'rect');
      expect(
        boxes.map((b) => b.getAttribute('fill')),
        'fills',
      ).toEqual(['#1e293b', '#ecfdf5']);
      expect(boxes[0].getAttribute('stroke'), 'outline').toBe('#334155');
    });
  });

  describe('picture', () => {
    it('when a file with two frames is given then two boxes are drawn in the frame colour', () => {
      const boxes = all(fixture, 'rect');

      expect(boxes.length, 'boxes').toBe(2);
      expect(boxes[0].getAttribute('fill'), 'fill').toBe('#ecfdf5');
    });

    it('when the file changes then the picture follows', async () => {
      source.set(file([frame('a', 0)]));
      await fixture.whenStable();

      expect(all(fixture, 'rect').length, 'boxes').toBe(1);
    });
  });
});
