import { trace } from '@opentelemetry/api';
import { Observable, Subject, firstValueFrom, of, throwError } from 'rxjs';

import { RecordedSpans, parentId, recordSpans } from '../test/tracing';
import {
  WithSpan,
  activeTraceContext,
  setTracingApi,
  startSpan,
  inTraceContext,
  withSpan,
} from './tracing';

const ERROR = 2;

class Commands {
  readonly calls: string[] = [];

  @WithSpan('Commands.sync')
  sync(value: number): number {
    this.calls.push('sync');
    return value * 2;
  }

  @WithSpan('Commands.async', { attributes: (id: string) => ({ 'task.id': id }) })
  async async(id: string, fail = false): Promise<string> {
    await Promise.resolve();
    if (fail) {
      throw new TypeError('async failure');
    }
    return id;
  }

  @WithSpan('Commands.outer')
  async outer(): Promise<string> {
    // the nested call starts before the first await -> child span
    const inner = await this.async('child');
    return `outer(${inner})`;
  }

  @WithSpan('Commands.throws')
  throws(): never {
    throw new Error('sync failure');
  }

  @WithSpan('Commands.stream')
  stream(source: Observable<number>): Observable<number> {
    return source;
  }
}

describe('tracing', () => {
  let spans: RecordedSpans;
  let commands: Commands;

  beforeEach(() => {
    spans = recordSpans();
    commands = new Commands();
  });

  afterEach(() => spans.stop());

  describe('WithSpan', () => {
    it('when a sync method returns then its span ends with the result unchanged', () => {
      expect(commands.sync(21), 'result').toBe(42);

      const span = spans.byName('Commands.sync');
      expect(span.ended, 'span ended').toBe(true);
      expect(span.status.code, 'status').not.toBe(ERROR);
      expect(commands.calls, 'this inside the method').toEqual(['sync']);
    });

    it('when an async method resolves then the span ends only after the promise settled', async () => {
      const pending = commands.async('t-1');

      expect(spans.finished(), 'finished spans while pending').toEqual([]);
      expect(await pending, 'result').toBe('t-1');
      expect(spans.byName('Commands.async').attributes, 'attributes from the arguments').toEqual({
        'task.id': 't-1',
      });
    });

    it('when an async method rejects then the span is an error with the exception and the rejection is kept', async () => {
      await expect(commands.async('t-2', true), 'rejection').rejects.toThrow('async failure');

      const span = spans.byName('Commands.async');
      expect(span.status, 'status').toEqual({ code: ERROR, message: 'async failure' });
      expect(span.attributes['error.type'], 'error.type').toBe('TypeError');
      expect(
        span.events.map((e) => e.name),
        'span events',
      ).toEqual(['exception']);
    });

    it('when a sync method throws then the span is an error and the error is re-thrown', () => {
      expect(() => commands.throws(), 'thrown error').toThrow('sync failure');

      expect(spans.byName('Commands.throws').status.code, 'status').toBe(ERROR);
    });

    it('when a decorated method calls another before its first await then that span is a child', async () => {
      expect(await commands.outer(), 'result').toBe('outer(child)');

      const outer = spans.byName('Commands.outer');
      const inner = spans.byName('Commands.async');
      expect(parentId(inner), 'parent of the inner span').toBe(outer.spanContext().spanId);
      expect(inner.spanContext().traceId, 'same trace').toBe(outer.spanContext().traceId);
      expect(parentId(outer), 'outer span is a root').toBe('');
    });

    it('when an Observable completes then the span ends with it', async () => {
      const source = new Subject<number>();
      const values = firstValueFrom(commands.stream(source));

      source.next(1);
      source.complete();

      expect(await values, 'first value').toBe(1);
      expect(spans.byName('Commands.stream').ended, 'span ended').toBe(true);
    });

    it('when an Observable errors then the span is an error', async () => {
      const failing = commands.stream(throwError(() => new Error('stream failure')));

      await expect(firstValueFrom(failing), 'error').rejects.toThrow('stream failure');
      expect(spans.byName('Commands.stream').status.code, 'status').toBe(ERROR);
    });

    it('when an Observable is unsubscribed early then the span still ends once', () => {
      const subscription = commands.stream(new Subject<number>()).subscribe();

      expect(spans.finished(), 'finished spans while subscribed').toEqual([]);
      subscription.unsubscribe();

      expect(spans.finished().length, 'finished spans after unsubscribe').toBe(1);
    });

    it('when the attributes callback fails then the method still runs, without attributes', () => {
      const decorate = WithSpan<[{ id: string } | undefined]>('Fragile.run', {
        attributes: (task) => ({ 'task.id': task!.id }),
      });
      const run = decorate((task: { id: string } | undefined) => task ?? 'none', {
        kind: 'method',
        name: 'run',
      } as ClassMethodDecoratorContext);

      expect(run(undefined), 'result').toBe('none');
      expect(spans.byName('Fragile.run').attributes, 'attributes').toEqual({});
    });

    it('when tracing is off then the method runs as it is and no span is recorded', async () => {
      setTracingApi(undefined);

      expect(commands.sync(2), 'sync result').toBe(4);
      expect(await commands.async('t-3'), 'async result').toBe('t-3');
      expect(spans.finished(), 'spans').toEqual([]);
    });

    it('when used as a standard decorator then the returned method is traced', () => {
      const decorate = WithSpan<[number]>('Standard.double', {
        attributes: (n) => ({ n }),
      });
      const double = decorate((n: number) => n * 2, {
        kind: 'method',
        name: 'double',
      } as ClassMethodDecoratorContext);

      expect(double(4), 'result').toBe(8);
      expect(spans.byName('Standard.double').attributes, 'attributes').toEqual({ n: 4 });
    });

    it('when a legacy decorator is applied to something else than a method then it refuses', () => {
      const decorate = WithSpan('Nope.field');

      expect(
        () => decorate({}, 'field', { get: () => () => undefined }),
        'decorating an accessor',
      ).toThrow("@WithSpan('Nope.field') can only decorate methods");
    });
  });

  describe('withSpan', () => {
    it('when plain code is wrapped then it runs as the active span', () => {
      const activeName = withSpan('helper', () => activeTraceContext() !== undefined);

      expect(activeName, 'active trace context inside').toBe(true);
      expect(activeTraceContext(), 'active trace context outside').toBeUndefined();
      expect(spans.byName('helper').ended, 'span ended').toBe(true);
    });
  });

  describe('inTraceContext', () => {
    it('when the source is subscribed later then it still sees the remembered span', () => {
      const remembered = withSpan('caller', () => activeTraceContext());
      let activeSpanId: string | undefined;
      const source = new Observable<void>((subscriber) => {
        activeSpanId = trace.getActiveSpan()?.spanContext().spanId;
        subscriber.complete();
      });

      inTraceContext(remembered!, () => source).subscribe();

      expect(activeSpanId, 'active span at subscription').toBe(
        spans.byName('caller').spanContext().spanId,
      );
    });

    it('when tracing is off then the source is returned as it is', () => {
      const source = of(1);
      const remembered = withSpan('caller', () => activeTraceContext());
      setTracingApi(undefined);

      expect(
        inTraceContext(remembered!, () => source),
        'source',
      ).toBe(source);
      expect(activeTraceContext(), 'active context without tracing').toBeUndefined();
    });
  });

  describe('startSpan', () => {
    it('when a parent is given then the span is its child and ends when the caller says so', () => {
      const parent = startSpan('parent');
      const child = startSpan('child', { parent: parent!.context, attributes: { a: 1 } });

      child!.span.end();
      parent!.span.end();

      expect(parentId(spans.byName('child')), 'parent of child').toBe(
        spans.byName('parent').spanContext().spanId,
      );
    });

    it('when tracing is off then nothing is started', () => {
      setTracingApi(undefined);

      expect(startSpan('nothing'), 'open span').toBeUndefined();
    });
  });
});
