// The demo's fetch interceptor (entry.ts loads it before the app): answers
// the app's API calls in the browser from generated sample data, so the real
// UI runs on a static host with no server.
import { mountDemoBanner } from './DemoBanner';
import { buildRouter } from './handlers';
import { json } from './lib/http';
import { DemoError, type DemoRequest } from './router';
import { resetDemo } from './store';
import { DEMO_TOKEN, DEMO_USER_ID } from './world';

const router = buildRouter();
const realFetch = window.fetch.bind(window);

// Matches /api/v1/<path> and a control plane's /sites/<id>/api/v1/<path>.
const API_PATH = /^(?:\/sites\/([^/]+))?\/api\/v1(\/.*)?$/;

async function readBody(init: RequestInit | undefined, request: Request | undefined) {
  const raw = init?.body ?? (request ? await request.clone().text() : undefined);
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request ? request.url : String(input), window.location.href);
  const match = url.origin === window.location.origin ? API_PATH.exec(url.pathname) : null;
  if (!match) return realFetch(input, init);

  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const path = match[2] ?? '/';
  const route = router.match(method, path);
  if (!route) {
    console.info(`[demo] no handler for ${method} ${path}`);
    return json({ message: 'Not available in the demo. Install Obzly to use this.' }, 403);
  }
  const req: DemoRequest = {
    method,
    path,
    params: route.params,
    query: url.searchParams,
    body: await readBody(init, request),
    signal: init?.signal ?? request?.signal,
    siteId: match[1] ? decodeURIComponent(match[1]) : undefined,
  };
  try {
    // A short, varied delay so loading states look like a real server.
    await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 120));
    const result = await route.handler(req);
    if (result instanceof Response) return result;
    return json(result ?? {});
  } catch (error) {
    if (error instanceof DemoError)
      return json({ message: error.message, error: error.message }, error.status);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    console.error('[demo] handler failed', method, path, error);
    // A 4xx, so apiHelper shows the message instead of retrying for 30 s.
    return json({ message: error instanceof Error ? error.message : String(error) }, 422);
  }
}

function signIn() {
  try {
    localStorage.setItem('obzly_user_token', DEMO_TOKEN);
    localStorage.setItem('obzly_user_id', DEMO_USER_ID);
  } catch {
    /* blocked storage: the app then shows sign-in, which also works */
  }
}

/** Sign out = start the demo over. */
export function restartDemo() {
  resetDemo();
  signIn();
  window.location.reload();
}

export function installDemo() {
  window.fetch = demoFetch;
  signIn();
  mountDemoBanner();
}

installDemo();
