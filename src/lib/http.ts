// Response helpers for the demo's fetch interceptor.

export const json = (data: unknown, status = 200): Response =>
  new Response(data === undefined ? '' : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const text = (body: string, contentType = 'text/plain', status = 200): Response =>
  new Response(body, { status, headers: { 'Content-Type': contentType } });

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

/**
 * An NDJSON stream: `produce` pushes frames with `send` and returns when done.
 * Closing (or the caller aborting) ends the stream.
 */
export function ndjson(
  produce: (send: (frame: unknown) => void, signal: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const controller = new AbortController();
  signal?.addEventListener('abort', () => controller.abort());
  const stream = new ReadableStream<Uint8Array>({
    async start(sink) {
      const send = (frame: unknown) => {
        if (!controller.signal.aborted) sink.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
      };
      try {
        await produce(send, controller.signal);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
        }
      }
      try {
        sink.close();
      } catch {
        /* already closed by a cancel */
      }
    },
    cancel() {
      controller.abort();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

/** "123.4ms" like Go's time.Duration.String(). */
export const goDuration = (ms: number): string =>
  ms < 1
    ? `${Math.round(ms * 1000)}µs`
    : ms < 1000
      ? `${ms.toFixed(1)}ms`
      : `${(ms / 1000).toFixed(2)}s`;
