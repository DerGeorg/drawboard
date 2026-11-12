import { ApplicationRef, DestroyRef, Service, inject } from '@angular/core';
import {
  Event,
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationStart,
  Router,
} from '@angular/router';
import type { Context } from '@opentelemetry/api';

import { routeTemplate } from '../util/route-template';
import { OpenSpan, fail, startSpan } from '../util/tracing';
import { stripQuery } from '../util/url';

/** Longest a navigation span waits for the page to settle (data loaded) after NavigationEnd. */
export const SETTLE_TIMEOUT_MS = 10_000;

/** Resource timings that are not fetch/XHR (those have their own spans): chunks, styles, images. */
const OWN_SPAN_INITIATORS = new Set(['fetch', 'xmlhttprequest', 'beacon']);

interface Navigation extends OpenSpan {
  readonly id: number;
  readonly resources?: PerformanceObserver;
}

/**
 * One span per router navigation: `navigation /boards/:boardId` (route template, never the
 * concrete URL), from NavigationStart until the new page has settled - guards, lazy chunks
 * and the data its resources load. Children: every HTTP call made while it is open without a
 * parent of its own (see traceContextInterceptor) and the chunk/style downloads as
 * `resource <type>` spans taken from the Resource Timing API.
 *
 * "Settled" = ApplicationRef.whenStable(): Angular counts pending HttpClient calls and
 * loading resources as pending tasks, so this is the moment the page shows its data.
 */
@Service()
export class NavigationTracing {
  private readonly router = inject(Router);
  private readonly appRef = inject(ApplicationRef);
  private readonly destroyRef = inject(DestroyRef);
  private current: Navigation | undefined;

  /** The context of the navigation in progress, if any. */
  context(): Context | undefined {
    return this.current?.context;
  }

  /** Called once tracing is up (provideFaro). */
  start(): void {
    const subscription = this.router.events.subscribe((event) => this.on(event));
    this.destroyRef.onDestroy(() => subscription.unsubscribe());
  }

  private on(event: Event): void {
    if (event instanceof NavigationStart) {
      this.begin(event);
    } else if (event instanceof NavigationEnd) {
      void this.settle(event.id);
    } else if (event instanceof NavigationCancel || event instanceof NavigationSkipped) {
      this.finish(event.id, (span) => span.setAttribute('navigation.outcome', 'cancelled'));
    } else if (event instanceof NavigationError) {
      this.finish(event.id, (span) => {
        span.setAttribute('navigation.outcome', 'error');
        fail(span, event.error);
      });
    }
  }

  private begin(event: NavigationStart): void {
    // a navigation still settling is superseded by the next one
    this.finish(this.current?.id, (span) => span.setAttribute('navigation.outcome', 'superseded'));
    const open = startSpan('navigation', {
      attributes: { 'navigation.trigger': event.navigationTrigger ?? 'imperative' },
    });
    if (open) {
      this.current = { ...open, id: event.id, resources: this.observeResources(open) };
    }
  }

  private async settle(id: number): Promise<void> {
    const navigation = this.current;
    if (navigation?.id !== id) {
      return;
    }
    const template = routeTemplate(this.router.routerState.snapshot.root);
    navigation.span.updateName(`navigation ${template}`);
    navigation.span.setAttribute('url.template', template);
    navigation.span.setAttribute('navigation.outcome', 'end');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.appRef.whenStable(),
      new Promise((resolve) => (timeout = setTimeout(resolve, SETTLE_TIMEOUT_MS))),
    ]);
    clearTimeout(timeout);
    this.finish(id);
  }

  private finish(id: number | undefined, mark?: (span: OpenSpan['span']) => void): void {
    const navigation = this.current;
    if (!navigation || navigation.id !== id) {
      return;
    }
    this.current = undefined;
    if (navigation.resources) {
      this.recordResources(navigation, navigation.resources.takeRecords());
      navigation.resources.disconnect();
    }
    mark?.(navigation.span);
    navigation.span.end();
  }

  private observeResources(open: OpenSpan): PerformanceObserver | undefined {
    if (typeof PerformanceObserver === 'undefined') {
      return undefined;
    }
    const observer = new PerformanceObserver((list) =>
      this.recordResources(open, list.getEntries()),
    );
    observer.observe({ type: 'resource' });
    return observer;
  }

  private recordResources(parent: OpenSpan, entries: PerformanceEntryList): void {
    for (const entry of entries as PerformanceResourceTiming[]) {
      if (OWN_SPAN_INITIATORS.has(entry.initiatorType)) {
        continue;
      }
      const resource = startSpan(`resource ${entry.initiatorType}`, {
        parent: parent.context,
        startTime: entry.startTime,
        attributes: {
          'url.full': stripQuery(entry.name),
          'http.response.body.size': entry.encodedBodySize,
        },
      });
      resource?.span.end(entry.responseEnd);
    }
  }
}
