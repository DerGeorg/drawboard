import { inputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BoardEngine } from '../../../../../board-engine/engine';
import { BoardDoc } from '@apps/drawboard-engine';
import { buttonByLabel, textOf } from '../../../../test/dom';
import { BoardZoom } from './board-zoom';

describe('BoardZoom', () => {
  let fixture: ComponentFixture<BoardZoom>;
  let engine: BoardEngine;
  let board: BoardDoc;
  let container: HTMLElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    board = new BoardDoc();
    engine = new BoardEngine(container, board);
    fixture = TestBed.createComponent(BoardZoom, {
      bindings: [inputBinding('engine', () => engine)],
    });
    await fixture.whenStable();
  });

  afterEach(() => {
    engine.destroy();
    board.destroy();
    container.remove();
  });

  describe('zoom', () => {
    it('when the zoom buttons are used then the percentage follows', async () => {
      expect(textOf(fixture), 'initial').toContain('100%');

      buttonByLabel(fixture, 'Zoom in').click();
      await fixture.whenStable();
      expect(textOf(fixture), 'zoomed in').toContain('125%');

      buttonByLabel(fixture, 'Zoom out').click();
      buttonByLabel(fixture, 'Zoom in').click();
      buttonByLabel(fixture, 'Reset zoom to 100%').click();
      await fixture.whenStable();
      expect(textOf(fixture), 'reset by clicking the percentage').toContain('100%');
    });

    it('when the camera changes elsewhere (wheel, pinch) then the percentage follows', async () => {
      engine.setCamera({ x: 0, y: 0, zoom: 2 });
      await fixture.whenStable();

      expect(textOf(fixture), 'percentage').toContain('200%');
    });

    it('when fit is clicked on an empty board then the camera goes back to the origin at 100 %', () => {
      engine.setCamera({ x: 40, y: 40, zoom: 3 });

      buttonByLabel(fixture, 'Fit board to screen').click();

      expect(engine.camera.zoom, 'zoom').toBe(1);
    });
  });
});
