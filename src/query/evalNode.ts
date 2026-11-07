// Evaluates the log search's QueryNode tree (entity/query/model/QueryNode.ts)
// against a generated log, the way the backend's querier does: names are
// normalized (dots and a "resource." prefix become underscores), levels and
// "contains" are case-insensitive.
import type { ConditionNode, QueryNode } from '../../entity/query';
import type { GenLog } from '../gen/logs';

export const normalizeField = (field: string): string =>
  field.replace(/^resource\./, '').replace(/\./g, '_');

export function fieldValue(log: GenLog, rawField: string): string | undefined {
  const field = rawField === 'pattern.hash' ? rawField : normalizeField(rawField);
  switch (field) {
    case 'message':
      return log.message;
    case 'level':
      return log.level;
    case 'client_ip':
      return log.clientIp;
    case 'trace_id':
      return log.traceId;
    case 'span_id':
      return log.spanId;
    case 'timestamp':
      return log.timestamp;
    case 'pattern.hash':
    case 'pattern_hash':
      return log.patternHash;
    default:
      return log.fields[field];
  }
}

const asNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value));

function compare(actual: string, expected: unknown, field: string): number {
  if (field === 'timestamp') {
    return Date.parse(actual) - Date.parse(String(expected));
  }
  return asNumber(actual) - asNumber(expected);
}

function evalCondition(log: GenLog, condition: ConditionNode): boolean {
  const { field, operator, value } = condition;
  const actual = fieldValue(log, field);
  const caseless = normalizeField(field) === 'level';
  const eq = (a: string, b: unknown) =>
    caseless ? a.toLowerCase() === String(b).toLowerCase() : a === String(b);
  switch (operator) {
    case 'exists':
      return actual !== undefined && actual !== '';
    case 'not_exists':
      return actual === undefined || actual === '';
    case 'equals':
      return actual !== undefined && eq(actual, value);
    case 'not_equals':
      return actual === undefined || !eq(actual, value);
    case 'contains':
      return (
        actual !== undefined && actual.toLowerCase().includes(String(value ?? '').toLowerCase())
      );
    case 'not_contains':
      return (
        actual === undefined || !actual.toLowerCase().includes(String(value ?? '').toLowerCase())
      );
    case 'in':
      return (
        actual !== undefined && (Array.isArray(value) ? value : [value]).some((v) => eq(actual, v))
      );
    case 'not_in':
      return (
        actual === undefined || !(Array.isArray(value) ? value : [value]).some((v) => eq(actual, v))
      );
    case 'greater_than':
      return actual !== undefined && compare(actual, value, field) > 0;
    case 'greater_or_equal':
      return actual !== undefined && compare(actual, value, field) >= 0;
    case 'less_than':
      return actual !== undefined && compare(actual, value, field) < 0;
    case 'less_or_equal':
      return actual !== undefined && compare(actual, value, field) <= 0;
    default:
      return false;
  }
}

export function matches(log: GenLog, node: QueryNode | null | undefined): boolean {
  if (!node) return true;
  if (node.type === 'condition') {
    return node.condition ? evalCondition(log, node.condition) : true;
  }
  const logic = node.logic;
  if (!logic) return true;
  switch (logic.operator) {
    case 'and':
      return logic.children.every((child) => matches(log, child));
    case 'or':
      return logic.children.length === 0 || logic.children.some((child) => matches(log, child));
    case 'not':
      return !logic.children.every((child) => matches(log, child));
    default:
      return true;
  }
}

/** Builds a predicate once per request. */
export const matcher =
  (node: QueryNode | null | undefined) =>
  (log: GenLog): boolean =>
    matches(log, node);
