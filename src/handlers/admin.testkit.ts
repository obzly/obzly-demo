// Test helper: calls a route on a Router the way install.ts does.
import { type DemoRequest, Router } from '../router';

export async function call<T = unknown>(
  router: Router,
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  const parsed = new URL(url, 'http://demo.test');
  // A Site call through the control plane's proxy: /sites/<id>/api/v1/<path>.
  const proxied = /^\/sites\/([^/]+)\/api\/v1(\/.*)$/.exec(parsed.pathname);
  const path = proxied ? proxied[2] : parsed.pathname;
  const route = router.match(method, path);
  if (!route) throw new Error(`no route for ${method} ${path}`);
  const req: DemoRequest = {
    method,
    path,
    siteId: proxied?.[1],
    params: route.params,
    query: parsed.searchParams,
    body,
  };
  return (await route.handler(req)) as T;
}

export const routerWith = (...registers: ((r: Router) => void)[]) => {
  const router = new Router();
  for (const register of registers) register(router);
  return router;
};
