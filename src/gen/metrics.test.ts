import { describe, expect, it } from 'vitest';

import { evaluatePromQL } from '../query/promql';
import {
  BATCH_HOST,
  NODES,
  PROJECT_ID,
  STAGING_PROJECT_ID,
  WORKLOADS,
  incidentStart,
  podsFor,
} from '../world';
import { allMetrics } from './metricRegistry';
import { generatedLabelValues, generatedSeries, isGeneratedMetric } from './metrics';

const NOW = Date.now();
const H = 3_600_000;
const M = 60_000;

const generated = (projectId: string) =>
  allMetrics(projectId).filter((info) => isGeneratedMetric(info.name));

describe('generated metrics', () => {
  it('keeps every counter monotonic between restarts', () => {
    const from = NOW - 8 * H;
    const problems: string[] = [];
    for (const info of generated(PROJECT_ID)) {
      if (info.type === 'gauge') continue;
      for (const series of generatedSeries(PROJECT_ID, info.name, [], from, NOW, 30_000, NOW)) {
        const { values, timestamps } = series;
        let drops = 0;
        for (let j = 1; j < values.length; j++) {
          if (values[j] >= values[j - 1]) continue;
          drops++;
          // A restart: the counter starts over near zero.
          if (values[j] > values[j - 1] * 0.25) {
            problems.push(
              `${info.name}${JSON.stringify(series.labels)} fell ${values[j - 1]} -> ${values[j]} at ${new Date(timestamps[j]).toISOString()}`,
            );
          }
        }
        if (drops > 4)
          problems.push(`${info.name}${JSON.stringify(series.labels)} restarted ${drops} times`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it('keeps histogram buckets cumulative', () => {
    for (const name of [
      'http_server_request_duration',
      'db_client_connection_wait_time',
      'jvm_gc_duration',
    ]) {
      const buckets = generatedSeries(
        PROJECT_ID,
        `${name}_bucket`,
        [],
        NOW - 2 * H,
        NOW,
        30_000,
        NOW,
      );
      const groups = new Map<string, typeof buckets>();
      for (const series of buckets) {
        const { le, __name__, ...rest } = series.labels;
        void le;
        void __name__;
        const key = JSON.stringify(rest);
        groups.set(key, [...(groups.get(key) ?? []), series]);
      }
      expect(groups.size).toBeGreaterThan(0);
      for (const group of groups.values()) {
        const sorted = [...group].sort(
          (a, b) =>
            (a.labels.le === '+Inf' ? Infinity : Number(a.labels.le)) -
            (b.labels.le === '+Inf' ? Infinity : Number(b.labels.le)),
        );
        expect(sorted[sorted.length - 1].labels.le).toBe('+Inf');
        for (let k = 1; k < sorted.length; k++) {
          const lower = sorted[k - 1];
          const upper = sorted[k];
          expect(upper.timestamps).toEqual(lower.timestamps);
          upper.values.forEach((v, j) => expect(v).toBeGreaterThanOrEqual(lower.values[j]));
        }
      }
    }
  });

  it('is deterministic and independent of the queried window', () => {
    const a = generatedSeries(
      PROJECT_ID,
      'http_server_request_duration_count',
      [],
      NOW - 2 * H,
      NOW - H,
      30_000,
      NOW,
    );
    const b = generatedSeries(
      PROJECT_ID,
      'http_server_request_duration_count',
      [],
      NOW - 3 * H,
      NOW,
      60_000,
      NOW,
    );
    const key = (labels: Record<string, string>) => JSON.stringify(labels);
    const byKey = new Map(b.map((s) => [key(s.labels), s]));
    expect(a.length).toBe(b.length);
    for (const series of a) {
      const other = byKey.get(key(series.labels))!;
      series.timestamps.forEach((t, j) => {
        const k = other.timestamps.indexOf(t);
        if (k >= 0) expect(other.values[k]).toBe(series.values[j]);
      });
    }
    const gaugeA = generatedSeries(
      PROJECT_ID,
      'k8s_node_memory_working_set',
      [],
      NOW - H,
      NOW,
      30_000,
      NOW,
    );
    const gaugeB = generatedSeries(
      PROJECT_ID,
      'k8s_node_memory_working_set',
      [],
      NOW - H,
      NOW,
      30_000,
      NOW,
    );
    expect(gaugeA.map((s) => s.values)).toEqual(gaugeB.map((s) => s.values));
  });

  it('has no samples outside the 14 days of demo data or in the future', () => {
    expect(
      generatedSeries(
        PROJECT_ID,
        'k8s_node_cpu_usage',
        [],
        NOW - 20 * 24 * H,
        NOW - 15 * 24 * H,
        30_000,
        NOW,
      ),
    ).toEqual([]);
    for (const series of generatedSeries(
      PROJECT_ID,
      'k8s_node_cpu_usage',
      [],
      NOW - H,
      NOW + H,
      30_000,
      NOW,
    )) {
      expect(series.timestamps[series.timestamps.length - 1]).toBeLessThanOrEqual(NOW);
    }
  });

  it('uses the world: its nodes, current pods, cluster and batch host', () => {
    const hosts = generatedLabelValues(PROJECT_ID, 'host_name', NOW - H, NOW);
    for (const node of NODES) expect(hosts.has(node)).toBe(true);
    expect(hosts.has(BATCH_HOST)).toBe(true);
    const pods = generatedLabelValues(PROJECT_ID, 'k8s_pod_name', NOW - 10 * M, NOW);
    for (const w of WORKLOADS)
      for (const pod of podsFor(w, NOW)) expect(pods.has(pod.name), pod.name).toBe(true);
    expect([...generatedLabelValues(PROJECT_ID, 'k8s_cluster_name', NOW - H, NOW)]).toEqual([
      'harborline-prod',
    ]);
    for (const value of generatedLabelValues(PROJECT_ID, 'user_email', NOW - H, NOW)) {
      expect(value).toMatch(/@harborline\.example\.com$/);
    }
  });

  it('gives staging app metrics only, and unknown projects nothing', () => {
    const staging = generated(STAGING_PROJECT_ID).map((info) => info.name);
    expect(staging).toContain('http_server_request_duration_bucket');
    expect(staging).not.toContain('k8s_node_cpu_usage');
    expect(
      allMetrics('00000000-0000-4000-8000-000000000000').filter((i) => isGeneratedMetric(i.name)),
    ).toEqual([]);
    const env = generatedLabelValues(
      STAGING_PROJECT_ID,
      'deployment_environment_name',
      NOW - H,
      NOW,
    );
    expect([...env]).toEqual(['staging']);
  });

  it('tells the incident story: payments slows and fails, Postgres runs out of connections', () => {
    const start = incidentStart(NOW - 6 * H);
    const before = start - 40 * M;
    const peak = start + 12 * M;
    const at = (query: string, t: number) =>
      evaluatePromQL(PROJECT_ID, { query, end: new Date(t).toISOString(), instant: true }).series[0]
        ?.points[0].value ?? 0;

    const p99 =
      'histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_bucket{service_name="payments"}[5m])))';
    expect(at(p99, before)).toBeLessThan(1.5);
    expect(at(p99, peak)).toBeGreaterThan(3);

    const errors =
      'sum(rate(http_server_request_duration_count{service_name="checkout", http_response_status_code=~"5.."}[5m])) / sum(rate(http_server_request_duration_count{service_name="checkout"}[5m]))';
    expect(at(errors, before)).toBeLessThan(0.01);
    expect(at(errors, peak)).toBeGreaterThan(0.1);

    expect(at('sum(postgresql_backends)', before)).toBeLessThan(140);
    expect(at('sum(postgresql_backends)', peak)).toBeGreaterThanOrEqual(190);
    expect(at('sum(postgresql_backends)', peak)).toBeLessThanOrEqual(200);

    const used =
      'max(db_client_connection_count{service_name="payments", db_client_connection_state="used"})';
    expect(at(used, peak)).toBe(20);
    expect(
      at('sum(db_client_connection_pending_requests{service_name="payments"})', peak),
    ).toBeGreaterThan(10);
    expect(
      at(
        'sum(increase(k8s_container_restarts{k8s_container_name="payments"}[30m]))',
        start + 25 * M,
      ),
    ).toBeGreaterThan(0);

    // The daily curve: evening traffic is well above the night's.
    const day = Math.floor(NOW / (24 * H)) * 24 * H - 24 * H;
    const rps = 'sum(rate(http_server_request_duration_count{service_name="storefront"}[5m]))';
    expect(at(rps, day + 18 * H)).toBeGreaterThan(2 * at(rps, day + 4 * H));
  });
});
