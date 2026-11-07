// The seeded dashboards and alert rules are written against metric names the
// metrics generator must produce: every metrics panel and metrics rule has to
// return data, or a visitor lands on empty charts.
import { describe, expect, it } from 'vitest';

import { evaluatePromQL } from './query/promql';
import { seedRules } from './seed/alerting';
import { seedDashboards } from './seed/dashboards';
import { PROJECT_ID } from './world';

const HOUR = 3_600_000;

describe('seeded metric queries return data', () => {
  const end = new Date(Date.now() - 60_000).toISOString();
  const start = new Date(Date.now() - 6 * HOUR).toISOString();

  const panels = seedDashboards().flatMap((dashboard) =>
    (dashboard.tabs ?? []).flatMap((tab) =>
      tab.panels
        .filter((panel) => panel.source === 'metrics' && panel.promQuery)
        .map((panel) => {
          let query = panel.promQuery!;
          for (const variable of dashboard.variables ?? []) {
            const value = variable.defaultValue ?? variable.staticValues?.[0] ?? '.*';
            query = query
              .split(`\${${variable.key}}`)
              .join(value)
              .split(`$${variable.key}`)
              .join(value);
          }
          return { name: `${dashboard.title} / ${tab.title} / ${panel.title}`, query };
        }),
    ),
  );

  it('finds the metrics panels', () => {
    expect(panels.length).toBeGreaterThan(5);
  });

  it.each(panels)('$name', ({ query }) => {
    const result = evaluatePromQL(PROJECT_ID, { query, start, end });
    expect(result.series.length, query).toBeGreaterThan(0);
  });

  const rules = seedRules()
    .map((rule) => ({ name: rule.name, query: (rule.query as { promql?: string }).promql }))
    .filter((rule): rule is { name: string; query: string } => !!rule.query);

  it.each(rules)('alert rule $name', ({ query }) => {
    const result = evaluatePromQL(PROJECT_ID, { query, instant: true, end });
    expect(result.series.length, query).toBeGreaterThan(0);
  });
});
