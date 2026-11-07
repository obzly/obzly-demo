import { Router } from '../router';
import { register as admin } from './admin';
import { register as aiUsage } from './aiUsage';
import { register as alerting } from './alerting';
import { register as bootstrap } from './bootstrap';
import { register as dashboards } from './dashboards';
import { register as inventory } from './inventory';
import { register as logs } from './logs';
import { register as metrics } from './metrics';
import { register as organizations } from './organizations';
import { register as serviceMap } from './serviceMap';
import { register as sites } from './sites';
import { register as synthetics } from './synthetics';
import { register as traces } from './traces';

/** Every area's routes; each area lives in its own file. */
export function buildRouter(): Router {
  const router = new Router();
  for (const register of [
    bootstrap,
    logs,
    traces,
    metrics,
    serviceMap,
    dashboards,
    alerting,
    synthetics,
    inventory,
    aiUsage,
    organizations,
    admin,
    sites,
  ]) {
    register(router);
  }
  return router;
}
