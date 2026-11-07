// A tiny method + path router for the demo's in-browser API. Paths are the
// part after /api/v1 (a control plane's /sites/:id/api/v1 prefix is stripped
// too), with :name segments as params and a trailing * matching the rest.

export interface DemoRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  signal?: AbortSignal;
  /** The Site id from a /sites/:siteId/api/v1 URL, if any. */
  siteId?: string;
}

/** A handler returns JSON-able data (200), a Response, or throws DemoError. */
export type Handler = (req: DemoRequest) => unknown | Promise<unknown>;

export class DemoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const NOT_IN_DEMO = 'Not available in the demo. Install Obzly to use this.';

export const notInDemo = (what?: string): never => {
  throw new DemoError(403, what ? `${what} isn't available in the demo.` : NOT_IN_DEMO);
};

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get = (pattern: string, handler: Handler) => this.on('GET', pattern, handler);
  post = (pattern: string, handler: Handler) => this.on('POST', pattern, handler);
  put = (pattern: string, handler: Handler) => this.on('PUT', pattern, handler);
  patch = (pattern: string, handler: Handler) => this.on('PATCH', pattern, handler);
  delete = (pattern: string, handler: Handler) => this.on('DELETE', pattern, handler);

  /** Every registered "METHOD /pattern", for the coverage test. */
  patterns(): string[] {
    return this.routes.map((route) => `${route.method} /${route.segments.join('/')}`);
  }

  match(
    method: string,
    path: string,
  ): { handler: Handler; params: Record<string, string> } | undefined {
    const parts = path.split('/').filter(Boolean);
    // Literal segments beat params, so /dashboards/:pid/folders wins over /dashboards/:pid/:id.
    let best: { handler: Handler; params: Record<string, string>; score: number } | undefined;
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      let score = 0;
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i];
        if (segment === '*') {
          params['*'] = parts.slice(i).join('/');
          score -= 100;
          break;
        }
        const part = parts[i];
        if (part === undefined) {
          ok = false;
          break;
        }
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(part);
        } else if (segment === part) {
          score += 2;
        } else {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (!route.segments.includes('*') && route.segments.length !== parts.length) continue;
      if (!best || score > best.score) best = { handler: route.handler, params, score };
    }
    return best && { handler: best.handler, params: best.params };
  }
}
