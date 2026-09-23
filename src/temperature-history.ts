import type { UnsClient } from '@uns-kit/core';

/** One numeric attribute published by rtt-demo-app. */
export const SOURCE_TOPIC = 'forge-group/novasteel/hot-rolling/hrm-pusher-furnace/equipment/zone-1/temperature';
export const EXPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const HISTORY_PAGE_SIZE = 2_000;
export const PREVIEW_SIZE = 500;
const MAX_HISTORY_REQUESTS = 2_000;

export type TemperatureRow = {
  time: string;
  temperatureC: number;
  uom: string;
};

export type TimeRange = { from: Date; to: Date };
export type HistoryReader = Pick<UnsClient, 'history'>;

export class ExportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function parseTimeRange(query: Record<string, unknown>): TimeRange {
  const parse = (key: 'from' | 'to'): Date => {
    const raw = query[key];
    if (typeof raw !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(raw)) {
      throw new ExportError(`${key} must be an ISO 8601 timestamp with a timezone.`, 400);
    }
    const date = new Date(raw);
    if (!Number.isFinite(date.getTime())) {
      throw new ExportError(`${key} is not a valid date.`, 400);
    }
    return date;
  };
  const from = parse('from');
  const to = parse('to');
  if (from > to) throw new ExportError('from must be at or before to.', 400);
  if (to.getTime() - from.getTime() > EXPORT_WINDOW_MS) {
    throw new ExportError('Choose at most seven days per export; this matches the demo history API window.', 400);
  }
  return { from, to };
}

export function requireBearer(headers: Record<string, unknown>): string {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = typeof value === 'string' ? /^Bearer\s+(\S+)$/i.exec(value.trim()) : null;
  if (!match?.[1]) throw new ExportError('A bearer token is required.', 401);
  return match[1];
}

export function normalizeTemperatureRow(record: Record<string, unknown>): TemperatureRow {
  const rawTime = record['time'] ?? record['timestamp'];
  const time = rawTime instanceof Date ? rawTime.toISOString() : String(rawTime ?? '');
  const numeric = record['numberValue'] ?? record['value'];
  if (numeric === null || numeric === undefined || numeric === '') {
    throw new ExportError('History returned a temperature row without a value; export was not truncated.', 502);
  }
  const temperatureC = typeof numeric === 'number' ? numeric : Number(numeric);
  if (!Number.isFinite(Date.parse(time)) || !Number.isFinite(temperatureC)) {
    throw new ExportError('History returned an invalid temperature row; export was not truncated.', 502);
  }
  return { time: new Date(time).toISOString(), temperatureC, uom: typeof record['uom'] === 'string' ? record['uom'] : '°C' };
}

export async function readWindow(
  client: HistoryReader,
  range: TimeRange,
  token: string,
  limit = HISTORY_PAGE_SIZE,
): Promise<{ rows: TemperatureRow[]; truncated: boolean }> {
  const result = await client.history(SOURCE_TOPIC, {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    limit,
    dedupe: false,
    token,
  });
  if (!result?.results.length) throw new ExportError('History API did not return the requested topic.', 502);
  const item = result.results[0]!;
  if (item.error) throw new ExportError(`History API: ${item.error}`, 502);
  return {
    rows: item.toRecords().map(normalizeTemperatureRow),
    truncated: item.stats?.['truncated'] === true || item.data.length >= limit,
  };
}

/** Split only full history windows. No backend limit is allowed to silently clip a file. */
export async function* exportTemperatureRows(
  client: HistoryReader,
  range: TimeRange,
  token: string,
  signal?: AbortSignal,
): AsyncGenerator<TemperatureRow> {
  let requestCount = 0;
  async function* window(fromMs: number, toMs: number): AsyncGenerator<TemperatureRow> {
    signal?.throwIfAborted();
    if (++requestCount > MAX_HISTORY_REQUESTS) {
      throw new ExportError('Export needs too many history requests; narrow the time range.', 413);
    }
    const page = await readWindow(client, { from: new Date(fromMs), to: new Date(toMs) }, token);
    signal?.throwIfAborted();
    if (!page.truncated) {
      for (const row of page.rows.sort((a, b) => a.time.localeCompare(b.time))) {
        signal?.throwIfAborted();
        yield row;
      }
      return;
    }
    if (fromMs >= toMs) {
      throw new ExportError('More measurements share one millisecond than the history API can return.', 413);
    }
    const midpoint = Math.floor((fromMs + toMs) / 2);
    yield* window(fromMs, midpoint);
    yield* window(midpoint + 1, toMs);
  }
  yield* window(range.from.getTime(), range.to.getTime());
}
