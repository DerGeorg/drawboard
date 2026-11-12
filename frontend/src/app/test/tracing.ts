import { context, propagation, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
  StackContextManager,
  WebTracerProvider,
} from '@opentelemetry/sdk-trace-web';

import { setTracingApi } from '../util/tracing';

/** Spans recorded by recordSpans(), finished ones only (like an exporter sees them). */
export interface RecordedSpans {
  /** Finished spans in the order they ended. */
  finished(): ReadableSpan[];
  /** The finished span with this name; fails the test when there is none. */
  byName(name: string): ReadableSpan;
  /** Unregisters the provider and switches util/tracing off again. */
  stop(): void;
}

/**
 * A real OpenTelemetry web SDK (StackContextManager, as without zone.js in the app) with an
 * in-memory exporter, registered as util/tracing's API - what FaroSession does in the app.
 * Call stop() in afterEach.
 */
export function recordSpans(): RecordedSpans {
  const exporter = new InMemorySpanExporter();
  const provider = new WebTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register({ contextManager: new StackContextManager() });
  setTracingApi({ trace, context });
  return {
    finished: () => exporter.getFinishedSpans(),
    byName(name) {
      const span = exporter.getFinishedSpans().find((s) => s.name === name);
      if (!span) {
        const names = exporter.getFinishedSpans().map((s) => s.name);
        throw new Error(`no finished span "${name}" among [${names.join(', ')}]`);
      }
      return span;
    },
    stop() {
      setTracingApi(undefined);
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}

/** Id of the span's parent ('' for a root span). */
export function parentId(span: ReadableSpan): string {
  return span.parentSpanContext?.spanId ?? '';
}
