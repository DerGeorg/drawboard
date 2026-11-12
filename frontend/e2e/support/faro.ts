import { Page } from '@playwright/test';

/** A span as Faro sends it (OTLP JSON), ids as lower-case hex. */
export interface SentSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string;
  readonly statusCode: number;
}

interface OtlpSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  status?: { code?: number };
}

interface FaroBody {
  traces?: { resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[] };
}

/** OTLP JSON carries hex ids; some encoders use base64. */
function hex(id: string | undefined): string {
  if (!id) {
    return '';
  }
  return /^[0-9a-f]+$/i.test(id) ? id.toLowerCase() : Buffer.from(id, 'base64').toString('hex');
}

/**
 * Switches Faro on for this page (the pipeline's image runs without a receiver) and captures
 * what it sends instead of forwarding it: /config.json gets a faro block with sampling rate 1,
 * POST /faro/collect is answered by the test. Returns the spans sent so far.
 */
export async function captureFaro(page: Page): Promise<() => SentSpan[]> {
  const spans: SentSpan[] = [];
  await page.route('**/config.json', async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as Record<string, unknown>;
    config['faro'] = {
      collectorUrl: '/faro/collect',
      appName: 'drawboard-frontend',
      namespace: 'drawboard',
      samplingRate: 1,
    };
    await route.fulfill({ response, json: config });
  });
  await page.route('**/faro/collect', async (route) => {
    const body = route.request().postDataJSON() as FaroBody;
    for (const resourceSpan of body.traces?.resourceSpans ?? []) {
      for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
        for (const span of scopeSpan.spans ?? []) {
          spans.push({
            name: span.name,
            traceId: hex(span.traceId),
            spanId: hex(span.spanId),
            parentSpanId: hex(span.parentSpanId),
            statusCode: span.status?.code ?? 0,
          });
        }
      }
    }
    await route.fulfill({ status: 202, json: {} });
  });
  return () => [...spans];
}

/** The chain of span names from `span` up to the root of its trace, innermost first. */
export function ancestry(spans: SentSpan[], span: SentSpan | undefined): string[] {
  const names: string[] = [];
  for (let current = span; current;) {
    names.push(current.name);
    const parent = current.parentSpanId;
    current = parent ? spans.find((s) => s.spanId === parent) : undefined;
  }
  return names;
}
