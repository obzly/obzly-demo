// Saved views for the Cost Explorer and Posture Trends: shared or private, with a default per
// tab. A shared view is read-only to everyone but its owner; the demo has one owner, the
// visitor, plus a shared view a teammate saved.
import type { SavedView, SavedViewKind, SavedViewRequest } from '../../entity/savedViews';
import { DemoError, type DemoRequest, type Router } from '../router';
import { collection, newId, value } from '../store';
import { DEMO_USER } from '../world';

interface StoredView {
  id: string;
  kind: SavedViewKind;
  name: string;
  shared: boolean;
  state: Record<string, unknown>;
  owner: string;
  updatedAt: string;
}

const TEAMMATE = 'priya.natarajan@harborline.example.com';

const views = collection<StoredView>('savedViews', () => [
  {
    id: '5a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
    kind: 'cost',
    name: 'Shop team by service, last 6 months',
    shared: true,
    state: {
      range: 'last6m',
      granularity: 'monthly',
      groupBy: 'service',
      metric: 'effective',
      filters: { tags: { team: ['shop'] } },
    },
    owner: TEAMMATE,
    updatedAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
  },
  {
    id: '6b8d0f2c-3e5a-4b7c-9d1e-2f3a4b5c6d7e',
    kind: 'posture',
    name: 'Critical and high, last 90 days',
    shared: true,
    state: {
      range: 'last90',
      granularity: 'monthly',
      filters: { severity: ['critical', 'high'] },
    },
    owner: TEAMMATE,
    updatedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
  },
]);

const defaults = value<Record<string, string | null>>('savedViews.defaults', () => ({}));

const bad = (message: string): never => {
  throw new DemoError(400, message);
};
const body = <T>(req: DemoRequest) => (req.body ?? {}) as T;

const view = (stored: StoredView): SavedView => ({
  ...stored,
  mine: stored.owner === DEMO_USER.email,
});

function checked(request: SavedViewRequest): SavedViewRequest {
  if (request.kind !== 'cost' && request.kind !== 'posture') bad('kind must be cost or posture');
  const name = (request.name ?? '').trim();
  if (!name || name.length > 100) bad('name must be 1 to 100 characters');
  return {
    kind: request.kind,
    name,
    shared: !!request.shared,
    state: request.state ?? {},
  };
}

function list(kind: string) {
  const visible = views
    .find((v) => v.kind === kind && (v.shared || v.owner === DEMO_USER.email))
    .sort((a, b) => a.name.localeCompare(b.name));
  const chosen = defaults.get()[kind] ?? null;
  return {
    views: visible.map(view),
    defaultId: chosen && visible.some((v) => v.id === chosen) ? chosen : null,
  };
}

function owned(id: string): StoredView {
  const stored = views.get(id);
  if (!stored) throw new DemoError(404, 'saved view not found');
  if (stored.owner !== DEMO_USER.email) {
    throw new DemoError(403, 'a shared view can only be changed by the person who saved it');
  }
  return stored;
}

export function register(r: Router) {
  r.get('/saved-views', (req) => list(req.query.get('kind') ?? 'cost'));
  r.post('/saved-views', (req) => {
    const request = checked(body<SavedViewRequest>(req));
    return view(
      views.insert({
        id: newId(),
        ...request,
        owner: DEMO_USER.email,
        updatedAt: new Date().toISOString(),
      }),
    );
  });
  r.put('/saved-views/default', (req) => {
    const { kind, viewId } = body<{
      kind: SavedViewKind;
      viewId: string | null;
    }>(req);
    if (kind !== 'cost' && kind !== 'posture') bad('kind must be cost or posture');
    defaults.set({ ...defaults.get(), [kind]: viewId });
    return list(kind);
  });
  r.put('/saved-views/:id', (req) => {
    owned(req.params.id);
    const request = checked(body<SavedViewRequest>(req));
    return view(
      views.update(req.params.id, {
        ...request,
        updatedAt: new Date().toISOString(),
      })!,
    );
  });
  r.delete('/saved-views/:id', (req) => {
    owned(req.params.id);
    views.remove(req.params.id);
    return {};
  });
}
