// Security posture: the Posture tab (standards, findings, finding drawer, trends, coverage,
// recommendations) and the asset drawer's findings, from ../seed/posture with the Site's rules:
// a score is passed of evaluated controls, a suppressed finding is left out of it, and an action
// is done when its findings resolve (an accepted risk when they were suppressed instead).
import type {
  ActionUpdate,
  ActionsResponse,
  CoverageRow,
  Finding,
  FindingDetail,
  FindingEvent,
  FindingUpdate,
  FindingsRequest,
  PostureAction,
  PostureAlertSettings,
  PostureFilters,
  PostureSummary,
  Severity,
  SimulatedScore,
  StandardScore,
  TrendsRequest,
} from '../../entity/posture';
import { DemoError, type DemoRequest, type Router } from '../router';
import { recordAudit } from '../seed/audit';
import { DAY } from '../seed/cost';
import {
  STANDARD_NAMES,
  type SeedFinding,
  type SeedRun,
  findingOf,
  findingSeed,
  hoursAgo,
  runSeed,
} from '../seed/posture';
import { collection, value } from '../store';
import { DEMO_USER, PROJECT_ID, STAGING_PROJECT_ID } from '../world';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'informational'];
const RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};
const WEIGHT: Record<string, number> = {
  critical: 10,
  high: 5,
  medium: 2,
  low: 1,
  informational: 0.2,
};
const EFFORT_COST: Record<string, number> = { low: 1, medium: 2, high: 4 };
const CONTROL_EFFORT: Record<string, string> = {
  'S3.8': 'low',
  'S3.9': 'low',
  'IAM.4': 'low',
  'EC2.7': 'low',
  'EC2.8': 'medium',
  'EC2.13': 'low',
  'RDS.3': 'high',
  'CloudTrail.1': 'low',
  'azure-storage-no-public-blob': 'low',
  'azure-nsg-no-world-ssh': 'low',
  'azure-storage-min-tls': 'low',
};

const bad = (message: string): never => {
  throw new DemoError(400, message);
};
const notFound = (what: string): never => {
  throw new DemoError(404, `${what} not found`);
};
const body = <T>(req: DemoRequest) => (req.body ?? {}) as T;
const percent = (part: number, whole: number) =>
  whole ? Math.round((part * 1000) / whole) / 10 : 0;

function projectsOf(projectId: string | null | undefined): string[] {
  if (!projectId) return [PROJECT_ID, STAGING_PROJECT_ID];
  if (projectId !== PROJECT_ID && projectId !== STAGING_PROJECT_ID) {
    throw new DemoError(403, "you can't see this project's posture");
  }
  return [projectId];
}

// --- findings with what visitors changed -----------------------------------------------

interface FindingChange {
  id: string;
  suppressed: boolean;
  suppressReason?: string;
  suppressedUntil?: string;
  suppressedBy?: string;
  events: FindingEvent[];
}

const changes = collection<FindingChange>('posture.findings', () => []);

function seedEvents(seed: SeedFinding, now: number): FindingEvent[] {
  const events: FindingEvent[] = [
    {
      kind: 'opened',
      severity: seed.severity,
      at: hoursAgo(seed.openedHoursAgo, now),
    },
  ];
  if (seed.suppressed) {
    events.push({
      kind: 'suppressed',
      severity: seed.severity,
      at: hoursAgo(seed.suppressed.hoursAgo, now),
      by: seed.suppressed.by,
      note: seed.suppressed.reason,
    });
  }
  if (seed.resolvedHoursAgo !== undefined) {
    events.push({
      kind: 'resolved',
      severity: seed.severity,
      at: hoursAgo(seed.resolvedHoursAgo, now),
    });
  }
  return events;
}

function findings(projects: string[], now = Date.now()): (Finding & { events: FindingEvent[] })[] {
  return findingSeed()
    .filter((seed) => projects.includes(seed.projectId))
    .map((seed) => {
      const finding = findingOf(seed, now);
      const change = changes.get(seed.id);
      const events = [...seedEvents(seed, now), ...(change?.events ?? [])];
      if (change) {
        finding.suppressed = change.suppressed;
        finding.suppressReason = change.suppressReason;
        finding.suppressedUntil = change.suppressedUntil;
        finding.suppressedBy = change.suppressedBy;
      }
      // An expired suppression lifts on its own.
      if (
        finding.suppressed &&
        finding.suppressedUntil &&
        Date.parse(finding.suppressedUntil) < now
      ) {
        finding.suppressed = false;
      }
      return { ...finding, events };
    });
}

function matches(finding: Finding, filters: PostureFilters, except?: string): boolean {
  switch (filters.status) {
    case 'all':
      break;
    case 'resolved':
      if (finding.status !== 'resolved') return false;
      break;
    case 'suppressed':
      if (finding.status !== 'open' || !finding.suppressed) return false;
      break;
    default:
      if (finding.status !== 'open' || finding.suppressed) return false;
  }
  const lists: [string, string[] | undefined, string][] = [
    ['severity', filters.severity, finding.severity],
    ['provider', filters.provider, finding.provider],
    ['account', filters.account, finding.account],
    ['region', filters.region, finding.region],
    ['source', filters.source, finding.source],
    ['connection', filters.connection, finding.connectionId],
    ['control', filters.control, finding.control],
    ['resource', filters.resource, finding.resourceKey],
  ];
  for (const [dimension, values, actual] of lists) {
    if (dimension !== except && values?.length && !values.includes(actual)) return false;
  }
  if (
    except !== 'standard' &&
    filters.standard?.length &&
    !finding.standards.some((s) => filters.standard!.includes(s.standard))
  ) {
    return false;
  }
  const search = (filters.search ?? '').trim().toLowerCase();
  return (
    !search ||
    [finding.title, finding.control, finding.resourceKey].some((text) =>
      text.toLowerCase().includes(search),
    )
  );
}

// --- scores, coverage, summary --------------------------------------------------------------

function runs(projects: string[]): SeedRun[] {
  return runSeed().filter((run) => projects.includes(run.projectId));
}

function scores(
  projects: string[],
  open: Finding[],
  fixed: Set<string> = new Set(),
): StandardScore[] {
  const evaluated = new Map<string, Set<string>>();
  const sources = new Map<string, Set<string>>();
  for (const run of runs(projects)) {
    if (run.result !== 'ok') continue;
    const set = evaluated.get(run.standard) ?? new Set<string>();
    for (const control of [...run.passed, ...run.failed]) set.add(control);
    evaluated.set(run.standard, set);
    sources.set(run.standard, (sources.get(run.standard) ?? new Set()).add(run.source));
  }
  const failed = new Map<string, Set<string>>();
  for (const finding of open) {
    if (finding.status !== 'open' || finding.suppressed || fixed.has(finding.id)) continue;
    for (const ref of finding.standards) {
      if (evaluated.get(ref.standard)?.has(ref.control)) {
        failed.set(ref.standard, (failed.get(ref.standard) ?? new Set()).add(ref.control));
      }
    }
  }
  return [...evaluated.keys()].sort().map((standard) => {
    const total = evaluated.get(standard)!.size;
    const bad = failed.get(standard)?.size ?? 0;
    return {
      standard,
      name: STANDARD_NAMES[standard] ?? standard,
      passed: total - bad,
      failed: bad,
      evaluated: total,
      percent: percent(total - bad, total),
      sources: [...(sources.get(standard) ?? [])].sort() as StandardScore['sources'],
    };
  });
}

/** Each standard's score on each of the last days, from when findings opened and resolved. */
function trendOf(projects: string[], all: (Finding & { events: FindingEvent[] })[], now: number) {
  const out = new Map<string, { day: string; percent: number }[]>();
  for (let ago = 29; ago >= 0; ago--) {
    const end = Math.floor(now / DAY) * DAY - ago * DAY + DAY;
    const openThen = all
      .filter(
        (f) => Date.parse(f.firstSeen) < end && (!f.resolvedAt || Date.parse(f.resolvedAt) >= end),
      )
      .map((f) => ({
        ...f,
        status: 'open' as const,
        suppressed:
          f.events.some((e) => e.kind === 'suppressed' && Date.parse(e.at) < end) && f.suppressed,
      }));
    for (const score of scores(projects, openThen)) {
      const list = out.get(score.standard) ?? [];
      list.push({
        day: new Date(end - DAY).toISOString().slice(0, 10),
        percent: score.percent,
      });
      out.set(score.standard, list);
    }
  }
  return out;
}

function coverage(projects: string[], now = Date.now()): CoverageRow[] {
  const rows = new Map<string, CoverageRow>();
  for (const run of runs(projects)) {
    const key = `${run.connectionId}|${run.account}|${run.region}`;
    const row = rows.get(key) ?? {
      connectionId: run.connectionId,
      connectionName: run.connectionName,
      provider: run.provider,
      account: run.account,
      region: run.region,
      status: 'not_covered' as const,
      scannedAt: hoursAgo(run.scannedHoursAgo, now),
      runs: [],
    };
    row.runs.push({
      standard: run.standard,
      source: run.source,
      result: run.result,
      reason: run.reason,
      passed: run.passed.length,
      failed: run.failed.length,
    });
    rows.set(key, row);
  }
  for (const row of rows.values()) {
    const nativeOK = row.runs.some((r) => r.source === 'native' && r.result === 'ok');
    const tried = row.runs.some((r) => r.source === 'native');
    const baselineOK = row.runs.some((r) => r.source === 'baseline' && r.result === 'ok');
    const reason = row.runs.find((r) => r.result !== 'ok')?.reason;
    if (nativeOK) row.status = 'native';
    else if (baselineOK && tried) {
      row.status = 'fallback';
      row.reason = reason;
    } else if (baselineOK) row.status = 'baseline';
    else row.reason = reason;
  }
  return [...rows.values()];
}

function summary(projects: string[], now = Date.now()): PostureSummary {
  const all = findings(projects, now);
  const standards = scores(projects, all);
  const trends = trendOf(projects, all, now);
  for (const s of standards) s.trend = trends.get(s.standard);
  const open: PostureSummary['open'] = {};
  let suppressed = 0;
  for (const f of all) {
    if (f.status !== 'open') continue;
    if (f.suppressed) suppressed++;
    else open[f.severity] = (open[f.severity] ?? 0) + 1;
  }
  const rows = coverage(projects, now);
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  return {
    standards,
    open,
    suppressed,
    resolved30d: all.filter((f) => f.resolvedAt && Date.parse(f.resolvedAt) > now - 30 * DAY)
      .length,
    coverage: {
      native: count('native'),
      fallback: count('fallback'),
      baseline: count('baseline'),
      notCovered: count('not_covered'),
      stale: count('stale'),
    },
    lastScanAt: rows
      .map((r) => r.scannedAt)
      .sort()
      .pop(),
  };
}

// --- trends -------------------------------------------------------------------------------

function trends(projects: string[], request: TrendsRequest, now = Date.now()) {
  const from = Date.parse(`${request.from}T00:00:00Z`);
  const to = Date.parse(`${request.to}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) bad('from and to are days, from first');
  if (request.granularity === 'daily' && (to - from) / DAY >= 92)
    bad('daily periods are for ranges of up to 92 days');
  const all = findings(projects, now).filter((f) =>
    matches(f, { ...request.filters, status: 'all' }),
  );
  const daily = trendOf(projects, findings(projects, now), now);
  const periods = [];
  for (let start = from; start <= to;) {
    const d = new Date(start);
    let next: number;
    let key: string;
    switch (request.granularity) {
      case 'daily':
        next = start + DAY;
        key = d.toISOString().slice(0, 10);
        break;
      case 'monthly':
        next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
        key = d.toISOString().slice(0, 7);
        break;
      case 'quarterly':
        next = Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3 + 3, 1);
        key = `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
        break;
      default:
        next = Date.UTC(d.getUTCFullYear() + 1, 0, 1);
        key = String(d.getUTCFullYear());
    }
    const end = Math.min(next, to + DAY);
    const open: Partial<Record<Severity, number>> = {};
    let opened = 0;
    let resolved = 0;
    for (const f of all) {
      const first = Date.parse(f.firstSeen);
      const gone = f.resolvedAt ? Date.parse(f.resolvedAt) : Infinity;
      if (first < end && gone >= end) open[f.severity] = (open[f.severity] ?? 0) + 1;
      if (first >= start && first < end) opened++;
      if (gone >= start && gone < end) resolved++;
    }
    const lastDay = new Date(end - DAY).toISOString().slice(0, 10);
    const scoresThen: Record<string, number> = {};
    for (const [standard, points] of daily) {
      const point = points.filter((p) => p.day <= lastDay).pop();
      if (point) scoresThen[standard] = point.percent;
    }
    periods.push({
      key,
      from: new Date(start).toISOString().slice(0, 10),
      to: lastDay,
      open,
      opened,
      resolved,
      scores: scoresThen,
    });
    start = next;
  }
  return { periods };
}

// --- actions --------------------------------------------------------------------------------

interface Guardrail {
  id: string;
  provider: string;
  regional: boolean;
  title: string;
  prevents: string[];
  closes: string[];
  effort: string;
  steps: (account: string, region: string) => string[];
}

const GUARDRAILS: Guardrail[] = [
  {
    id: 'aws-s3-account-block-public-access',
    provider: 'aws',
    regional: false,
    title: 'Turn on S3 Block Public Access for the whole account',
    prevents: ['S3.2', 'S3.3', 'S3.8'],
    closes: ['S3.1'],
    effort: 'low',
    steps: (account) => [
      "Check no bucket needs to be public on purpose (static sites behind CloudFront don't).",
      `aws s3control put-public-access-block --account-id ${account} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`,
    ],
  },
  {
    id: 'aws-imdsv2-default',
    provider: 'aws',
    regional: true,
    title: 'Make IMDSv2 the default for new instances',
    prevents: ['EC2.8'],
    closes: [],
    effort: 'low',
    steps: (_, region) => [
      'New instances get IMDSv2 only; existing ones keep their setting until you change them.',
      `aws ec2 modify-instance-metadata-defaults --region ${region} --http-tokens required --http-put-response-hop-limit 2`,
    ],
  },
  {
    id: 'aws-ebs-encryption-default',
    provider: 'aws',
    regional: true,
    title: 'Turn on EBS encryption by default',
    prevents: ['EC2.3'],
    closes: ['EC2.7'],
    effort: 'low',
    steps: (_, region) => [
      "New volumes and snapshot copies are encrypted; existing volumes aren't changed.",
      `aws ec2 enable-ebs-encryption-by-default --region ${region}`,
    ],
  },
  {
    id: 'azure-deny-open-management-ports',
    provider: 'azure',
    regional: false,
    title: 'Assign an Azure Policy that denies SSH and RDP open to the internet',
    prevents: ['azure-nsg-no-world-ssh', 'azure-nsg-no-world-rdp'],
    closes: [],
    effort: 'medium',
    steps: (account) => [
      'Create a custom policy with the deny effect for network security group rules that allow inbound 22 or 3389 from *, Internet or 0.0.0.0/0, and assign it to the subscription.',
      'az policy definition create --name deny-open-management-ports --mode All --rules rules.json',
      `az policy assignment create --name deny-open-management-ports --policy deny-open-management-ports --scope /subscriptions/${account}`,
    ],
  },
  {
    id: 'azure-deny-public-blob',
    provider: 'azure',
    regional: false,
    title: 'Assign the built-in policy that denies anonymous blob access',
    prevents: ['azure-storage-no-public-blob'],
    closes: [],
    effort: 'low',
    steps: (account) => [
      `az policy definition list --query "[?displayName=='Storage account public access should be disallowed'].name" -o tsv`,
      `az policy assignment create --name deny-public-blob --policy <the name above> --params '{"effect": {"value": "Deny"}}' --scope /subscriptions/${account}`,
    ],
  },
];

interface StoredActionState {
  id: string;
  projectId: string;
  title: string;
  planned: boolean;
  dismissed: boolean;
  reason?: string;
  findingIds: string[];
}

const actionStates = collection<StoredActionState>('posture.actions', () => []);
const stateId = (projectId: string, key: string) => `${projectId}|${key}`;

const shortName = (resource: string) => {
  const i = Math.max(resource.lastIndexOf('/'), resource.lastIndexOf(':'));
  return i >= 0 && i < resource.length - 1 ? resource.slice(i + 1) : resource;
};

const asActionFinding = (f: Finding) => ({
  id: f.id,
  control: f.control,
  title: f.title,
  severity: f.severity,
  resourceKey: f.resourceKey,
  status: f.status,
  suppressed: f.suppressed,
});

function fixAction(group: Finding[], key: string): PostureAction {
  const first = group[0];
  const action: PostureAction = {
    key,
    projectId: first.projectId,
    kind: 'fix',
    title: first.title,
    connectionName: first.connectionName,
    provider: first.provider,
    account: first.account,
    effort: 'low',
    rank: 0,
    findings: group.map(asActionFinding),
    status: 'open',
    planned: false,
    dismissed: false,
  };
  let worth = 0;
  for (const f of group) {
    worth += WEIGHT[f.severity];
    const effort = CONTROL_EFFORT[f.control] ?? 'medium';
    if (EFFORT_COST[effort] > EFFORT_COST[action.effort])
      action.effort = effort as PostureAction['effort'];
    if (!action.severity || RANK[f.severity] < RANK[action.severity]) action.severity = f.severity;
  }
  action.rank = worth / EFFORT_COST[action.effort];
  return action;
}

function actions(projects: string[], now = Date.now()): ActionsResponse {
  const all = findings(projects, now);
  const open = all.filter((f) => f.status === 'open');
  const active = open.filter((f) => !f.suppressed);
  // Fixes: one per resource with several findings, one per control where several resources
  // have only that one, one per finding otherwise.
  const byResource = new Map<string, Finding[]>();
  for (const f of active) {
    const key = `${f.projectId}|${f.connectionId}|${f.resourceKey}`;
    byResource.set(key, [...(byResource.get(key) ?? []), f]);
  }
  const fixes: PostureAction[] = [];
  const singles = new Map<string, Finding[]>();
  for (const group of byResource.values()) {
    if (group.length === 1) {
      const f = group[0];
      const key = `${f.projectId}|${f.connectionId}|${f.account}|${f.control}`;
      singles.set(key, [...(singles.get(key) ?? []), f]);
      continue;
    }
    const action = fixAction(
      group,
      `fix:resource:${group[0].connectionId}:${group[0].resourceKey}`,
    );
    action.title = `Fix ${group.length} findings on ${shortName(group[0].resourceKey)}`;
    action.detail = group.map((f) => f.title).join('; ');
    action.region = group[0].region;
    fixes.push(action);
  }
  for (const group of singles.values()) {
    const f = group[0];
    if (group.length === 1) {
      const action = fixAction(
        group,
        `fix:finding:${f.connectionId}:${f.control}:${f.resourceKey}`,
      );
      action.detail = shortName(f.resourceKey);
      action.region = f.region;
      fixes.push(action);
      continue;
    }
    const action = fixAction(group, `fix:control:${f.connectionId}:${f.account}:${f.control}`);
    action.title = `${f.title} (${group.length} resources)`;
    action.detail = group.map((g) => shortName(g.resourceKey)).join(', ');
    fixes.push(action);
  }
  // Guardrails where findings they prevent or close are open.
  const rails = new Map<string, PostureAction>();
  for (const f of open) {
    for (const rail of GUARDRAILS) {
      if (rail.provider !== f.provider) continue;
      const closes = rail.closes.includes(f.control);
      if (!closes && !rail.prevents.includes(f.control)) continue;
      const region = rail.regional ? f.region : '';
      const key = `guardrail:${rail.id}:${f.connectionId}:${f.account}:${region}`;
      const action = rails.get(`${f.projectId}|${key}`) ?? {
        key,
        projectId: f.projectId,
        kind: 'guardrail' as const,
        title: rail.title,
        connectionName: f.connectionName,
        provider: f.provider,
        account: f.account,
        region: region || undefined,
        effort: rail.effort as PostureAction['effort'],
        rank: 0,
        findings: [],
        prevents: [...rail.prevents, ...rail.closes],
        steps: rail.steps(f.account, region),
        status: 'open' as const,
        planned: false,
        dismissed: false,
      };
      if (closes) action.findings.push(asActionFinding(f));
      action.rank += WEIGHT[f.severity] / 2;
      rails.set(`${f.projectId}|${key}`, action);
    }
  }
  const guardrails = [...rails.values()].map((a) => ({
    ...a,
    rank: a.rank / EFFORT_COST[a.effort],
    detail: `Stops ${a.prevents!.join(', ')} coming back in ${a.account}${a.region ? ` / ${a.region}` : ''}`,
  }));
  // The guardrail is the fix where it closes the finding itself.
  const closedByRails = new Set(guardrails.flatMap((a) => a.findings.map((f) => f.id)));
  const keptFixes = fixes.filter((a) => !a.findings.every((f) => closedByRails.has(f.id)));
  // Coverage gaps: scopes a source couldn't read; nothing read at all ranks first.
  const coverageActions = new Map<string, PostureAction>();
  const projectRuns = runs(projects);
  for (const run of projectRuns) {
    if (run.result === 'ok') continue;
    const key = `coverage:${run.connectionId}:${run.source}:${run.result}`;
    const fellBack = projectRuns.some(
      (r) =>
        r.result === 'ok' &&
        r.connectionId === run.connectionId &&
        r.account === run.account &&
        r.region === run.region,
    );
    const existing = coverageActions.get(key);
    const scope = `${run.account}/${run.region}`;
    if (existing) {
      if (!existing.scopes!.includes(scope)) existing.scopes!.push(scope);
      continue;
    }
    const aws = run.provider === 'aws';
    coverageActions.set(key, {
      key,
      projectId: run.projectId,
      kind: 'coverage',
      title:
        run.result === 'not_enabled'
          ? aws
            ? 'Turn on Security Hub'
            : 'Turn on Microsoft Defender for Cloud'
          : `Add the posture permissions to ${run.connectionName}`,
      detail: run.reason,
      connectionName: run.connectionName,
      provider: run.provider,
      effort: 'low',
      rank: fellBack ? 100 : 1000,
      findings: [],
      scopes: [scope],
      steps: aws
        ? [
            'Security Hub charges about $0.001 per check; the Obzly baseline covers these regions meanwhile.',
            'aws securityhub enable-security-hub --enable-default-standards --region <region>',
          ]
        : [
            'Foundational CSPM is free; it assesses the subscription against the Microsoft cloud security benchmark once the Microsoft.Security resource provider is registered.',
            'az provider register --namespace Microsoft.Security --subscription <subscription>',
          ],
      status: 'open',
      planned: false,
      dismissed: false,
    });
  }
  let list: PostureAction[] = [...coverageActions.values(), ...keptFixes, ...guardrails];
  const listed = new Set(list.map((a) => stateId(a.projectId, a.key)));
  for (const action of list) {
    const state = actionStates.get(stateId(action.projectId, action.key));
    if (state)
      Object.assign(action, {
        planned: state.planned,
        dismissed: state.dismissed,
        dismissReason: state.reason,
      });
  }
  // Planned actions whose findings all closed: done, or an accepted risk if suppressed instead.
  const byId = new Map(all.map((f) => [f.id, f]));
  for (const state of actionStates.all()) {
    if (!state.planned || listed.has(state.id) || !projects.includes(state.projectId)) continue;
    const its = state.findingIds
      .map((id) => byId.get(id))
      .filter((f): f is (typeof all)[number] => !!f);
    const stillOpen = its.some((f) => f.status === 'open' && !f.suppressed);
    list.push({
      key: state.id.slice(state.projectId.length + 1),
      projectId: state.projectId,
      kind: state.id.includes('|guardrail:') ? 'guardrail' : 'fix',
      title: state.title,
      connectionName: its[0]?.connectionName,
      provider: its[0]?.provider,
      account: its[0]?.account,
      effort: 'low',
      rank: stillOpen ? 0 : -1,
      findings: its.map(asActionFinding),
      status: stillOpen ? 'open' : its.some((f) => f.suppressed) ? 'accepted_risk' : 'done',
      planned: true,
      dismissed: state.dismissed,
      dismissReason: state.reason,
    });
  }
  list = list.sort((a, b) => b.rank - a.rank);
  const plan = new Set<string>();
  const everything = new Set<string>();
  for (const action of list) {
    if (action.dismissed || action.kind === 'coverage' || action.status !== 'open') continue;
    for (const f of action.findings) {
      if (f.suppressed) continue;
      everything.add(f.id);
      if (action.planned) plan.add(f.id);
    }
  }
  const now_ = scores(projects, all);
  const withPlan = scores(projects, all, plan);
  const withAll = scores(projects, all, everything);
  const standards: SimulatedScore[] = now_.map((s, i) => ({
    standard: s.standard,
    name: s.name,
    evaluated: s.evaluated,
    current: s.percent,
    withPlan: withPlan[i].percent,
    withAll: withAll[i].percent,
  }));
  return { actions: list, standards };
}

function updateAction(update: ActionUpdate): PostureAction {
  if (update.planned === undefined && update.dismissed === undefined)
    bad('set planned or dismissed');
  if (update.dismissed && !(update.reason ?? '').trim()) bad("say why it's dismissed");
  projectsOf(update.projectId);
  const action =
    actions([update.projectId]).actions.find((a) => a.key === update.key) ?? notFound('Action');
  const id = stateId(update.projectId, update.key);
  const previous = actionStates.get(id);
  const state: StoredActionState = {
    id,
    projectId: update.projectId,
    title: action.title,
    planned: update.planned ?? previous?.planned ?? false,
    dismissed: update.dismissed ?? previous?.dismissed ?? false,
    reason:
      update.dismissed === undefined
        ? previous?.reason
        : update.dismissed
          ? update.reason?.trim()
          : undefined,
    findingIds:
      update.planned && action.status === 'open'
        ? action.findings.map((f) => f.id)
        : (previous?.findingIds ?? []),
  };
  if (previous) actionStates.update(id, state);
  else actionStates.insert(state);
  const verb =
    update.planned !== undefined
      ? update.planned
        ? 'Planned'
        : 'Took out of the plan'
      : update.dismissed
        ? 'Dismissed'
        : 'Restored';
  recordAudit(`${verb} posture action "${action.title}"`, update.projectId);
  return (
    actions([update.projectId]).actions.find((a) => a.key === update.key) ?? notFound('Action')
  );
}

// --- routes -----------------------------------------------------------------------------

const postureAlerts = value<Record<string, PostureAlertSettings>>('posture.alerts', () => ({}));

export function register(r: Router) {
  r.get('/posture/summary', (req) => summary(projectsOf(req.query.get('projectId'))));
  r.post('/posture/findings', (req) => {
    const request = body<FindingsRequest>(req);
    const list = findings(projectsOf(req.query.get('projectId'))).filter((f) =>
      matches(f, request.filters ?? {}),
    );
    const order: Record<string, (f: Finding) => string | number> = {
      firstSeen: (f) => f.firstSeen,
      lastSeen: (f) => f.lastSeen,
      title: (f) => f.title.toLowerCase(),
      severity: (f) => RANK[f.severity],
    };
    const sort = request.sort ?? 'severity';
    const key = order[sort] ?? order.severity;
    // Dates newest first by default; severity and title in their natural order.
    const descending = request.desc !== (sort === 'firstSeen' || sort === 'lastSeen');
    list.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      const c = x < y ? -1 : x > y ? 1 : b.lastSeen.localeCompare(a.lastSeen);
      return descending ? -c : c;
    });
    const limit = Math.min(Math.max(request.limit || 50, 1), 200);
    const offset = Math.max(request.offset ?? 0, 0);
    return {
      total: list.length,
      findings: list.slice(offset, offset + limit).map(({ events, ...f }) => (void events, f)),
    };
  });
  r.get('/posture/findings/:id', (req): FindingDetail => {
    const finding =
      findings(projectsOf(null)).find((f) => f.id === req.params.id) ?? notFound('Finding');
    const seed = findingSeed().find((s) => s.id === finding.id);
    const { events, ...rest } = finding;
    return {
      ...rest,
      events: [...events].sort((a, b) => b.at.localeCompare(a.at)),
      standardNames: Object.fromEntries(
        finding.standards.map((s) => [s.standard, STANDARD_NAMES[s.standard] ?? s.standard]),
      ),
      remediation: seed?.remediation,
    };
  });
  r.patch('/posture/findings/:id', (req) => {
    const update = body<FindingUpdate>(req);
    const finding =
      findings(projectsOf(null)).find((f) => f.id === req.params.id) ?? notFound('Finding');
    const reason = (update.reason ?? '').trim();
    if (update.suppressed && !reason) bad('say why it is suppressed');
    if (update.until && Number.isNaN(Date.parse(update.until)))
      bad('until is a date and time (RFC 3339)');
    const previous = changes.get(finding.id);
    const event: FindingEvent = {
      kind: update.suppressed ? 'suppressed' : 'unsuppressed',
      severity: finding.severity,
      at: new Date().toISOString(),
      by: DEMO_USER.email,
      note: reason || undefined,
    };
    const change: FindingChange = {
      id: finding.id,
      suppressed: update.suppressed,
      suppressReason: update.suppressed ? reason : undefined,
      suppressedUntil: update.suppressed ? update.until : undefined,
      suppressedBy: update.suppressed ? DEMO_USER.email : undefined,
      events: [...(previous?.events ?? []), event],
    };
    if (previous) changes.update(finding.id, change);
    else changes.insert(change);
    recordAudit(
      `${update.suppressed ? 'Suppressed' : 'Unsuppressed'} posture finding ${finding.control} on ${finding.resourceKey}${reason ? `: ${reason}` : ''}`,
      finding.projectId,
    );
    const { events, ...updated } = findings([finding.projectId]).find((f) => f.id === finding.id)!;
    void events;
    return updated;
  });
  r.post('/posture/facets', (req) => {
    const filters = body<PostureFilters>(req);
    const all = findings(projectsOf(req.query.get('projectId')));
    const dimensions: Record<string, { value: string; label?: string; count: number }[]> = {};
    const columns: Record<string, (f: Finding) => string> = {
      severity: (f) => f.severity,
      provider: (f) => f.provider,
      account: (f) => f.account,
      region: (f) => f.region,
      source: (f) => f.source,
      connection: (f) => f.connectionId,
    };
    for (const [dimension, of] of Object.entries(columns)) {
      const counts = new Map<string, { value: string; label?: string; count: number }>();
      for (const f of all.filter((x) => matches(x, filters, dimension))) {
        const v = of(f);
        const entry = counts.get(v) ?? {
          value: v,
          label: dimension === 'connection' ? f.connectionName : undefined,
          count: 0,
        };
        entry.count++;
        counts.set(v, entry);
      }
      dimensions[dimension] = [...counts.values()].sort(
        (a, b) => b.count - a.count || a.value.localeCompare(b.value),
      );
    }
    const standards = new Map<string, number>();
    for (const f of all.filter((x) => matches(x, filters, 'standard'))) {
      for (const s of new Set(f.standards.map((ref) => ref.standard)))
        standards.set(s, (standards.get(s) ?? 0) + 1);
    }
    dimensions.standard = [...standards.entries()]
      .map(([v, count]) => ({ value: v, label: STANDARD_NAMES[v], count }))
      .sort((a, b) => b.count - a.count);
    return { dimensions };
  });
  r.post('/posture/trends', (req) =>
    trends(projectsOf(req.query.get('projectId')), body<TrendsRequest>(req)),
  );
  r.get('/posture/coverage', (req) => coverage(projectsOf(req.query.get('projectId'))));
  r.get('/posture/resource', (req) => {
    const key = (req.query.get('key') ?? '').trim() || bad('key is required');
    return findings(projectsOf(req.query.get('projectId')))
      .filter(
        (f) =>
          f.status === 'open' &&
          (f.resourceKey === key ||
            f.resourceKey.toLowerCase() === key.toLowerCase() ||
            f.resourceKey.endsWith(`/${key}`)),
      )
      .sort((a, b) => RANK[a.severity] - RANK[b.severity])
      .map(({ events, ...f }) => (void events, f));
  });
  r.get(
    '/projects/:id/posture-alerts',
    (req) =>
      postureAlerts.get()[req.params.id] ?? {
        channelIds: [],
        minSeverity: 'high',
      },
  );
  r.put('/projects/:id/posture-alerts', (req) => {
    projectsOf(req.params.id);
    const settings = body<PostureAlertSettings>(req);
    if (!SEVERITIES.slice(0, 4).includes(settings.minSeverity))
      bad('minSeverity is critical, high, medium or low');
    const saved = {
      channelIds: settings.channelIds ?? [],
      minSeverity: settings.minSeverity,
    };
    postureAlerts.set({ ...postureAlerts.get(), [req.params.id]: saved });
    return saved;
  });
  r.get('/posture/actions', (req) => actions(projectsOf(req.query.get('projectId'))));
  r.patch('/posture/actions', (req) => updateAction(body<ActionUpdate>(req)));
}
