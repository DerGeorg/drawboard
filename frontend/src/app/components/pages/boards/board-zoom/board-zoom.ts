import { Component, effect, input, signal } from '@angular/core';

import { BoardEngine } from '../../../../../board-engine/engine';
import { Icon } from '../../../shared/icon/icon';

/** Zoom out, zoom level (click = 100 %), zoom in and fit - the pill at the bottom right. */
@Component({
  selector: 'drawboard-board-zoom',
  imports: [Icon],
  templateUrl: './board-zoom.html',
})
export class BoardZoom {
  readonly engine = input<BoardEngine>();

  protected readonly zoomPercent = signal(100);

  constructor() {
    effect((onCleanup) => {
      const engine = this.engine();
      if (!engine) {
        return;
      }
      this.zoomPercent.set(Math.round(engine.camera.zoom * 100));
      const off = engine.cameraChanged.on((c) => this.zoomPercent.set(Math.round(c.zoom * 100)));
      onCleanup(off);
    });
  }
}
