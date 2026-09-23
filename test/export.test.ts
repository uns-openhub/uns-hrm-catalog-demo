import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import type { UnsClient } from '@uns-kit/core';
import { prepareExportFile } from '../src/export-files.js';
import {
  ExportError,
  SOURCE_TOPIC,
  exportTemperatureRows,
  normalizeTemperatureRow,
  parseTimeRange,
  type TemperatureRow,
} from '../src/temperature-history.js';

test('one time range accepts a large export window but rejects invalid or oversized ranges', () => {
  const range = parseTimeRange({ from: '2026-09-01T00:00:00Z', to: '2026-09-08T00:00:00Z' });
  assert.equal(range.to.getTime() - range.from.getTime(), 7 * 24 * 60 * 60 * 1000);
  assert.throws(() => parseTimeRange({ from: '2026-09-01', to: '2026-09-02T00:00:00Z' }), ExportError);
  assert.throws(() => parseTimeRange({ from: '2026-09-01T00:00:00Z', to: '2026-09-09T00:00:00Z' }), ExportError);
});

test('missing temperature is rejected rather than exported as zero', () => {
  assert.throws(() => normalizeTemperatureRow({ time: '2026-09-23T12:00:00Z', value: null }), ExportError);
});

test('full export splits backend-limited history without dropping or repeating a row', async () => {
  const start = Date.parse('2026-09-23T00:00:00Z');
  const source = Array.from({ length: 5_010 }, (_, index) => ({
    time: new Date(start + index * 1_000).toISOString(),
    value: 900 + index / 100,
    uom: '°C',
  }));
  let calls = 0;
  const client = {
    async history(topic: string, options: { from: string; to: string; limit: number; token: string }) {
      calls++;
      assert.equal(topic, SOURCE_TOPIC);
      assert.equal(options.token, 'caller-token');
      const matching = source.filter((row) => row.time >= options.from && row.time <= options.to);
      const records = matching.slice(0, options.limit);
      return {
        results: [
          {
            error: null,
            data: records,
            stats: { truncated: matching.length >= options.limit },
            toRecords: () => records,
          },
        ],
      };
    },
  } as unknown as Pick<UnsClient, 'history'>;
  const rows: TemperatureRow[] = [];
  for await (const row of exportTemperatureRows(
    client,
    {
      from: new Date(start),
      to: new Date(start + 5_009_000),
    },
    'caller-token',
  ))
    rows.push(row);
  assert.ok(calls > 1);
  assert.equal(rows.length, source.length);
  assert.deepEqual(
    rows.map((row) => row.time),
    source.map((row) => row.time),
  );
  assert.equal(rows[0]?.temperatureC, 900);
  assert.equal(rows.at(-1)?.temperatureC, 950.09);
});

test('CSV and Parquet files are generated from an async row stream and cleaned up', async () => {
  const rows: TemperatureRow[] = [
    { time: '2026-09-23T12:00:00.000Z', temperatureC: 920.5, uom: '°C' },
    { time: '2026-09-23T12:00:01.000Z', temperatureC: 921, uom: '°C' },
  ];
  async function* source(): AsyncGenerator<TemperatureRow> {
    yield* rows;
  }
  const csv = await prepareExportFile('csv', source());
  try {
    assert.equal(
      await readFile(csv.path, 'utf8'),
      'time,temperatureC,uom\n2026-09-23T12:00:00.000Z,920.5,°C\n2026-09-23T12:00:01.000Z,921,°C\n',
    );
  } finally {
    await csv.cleanup();
  }
  const parquet = await prepareExportFile('parquet', source());
  try {
    const bytes = await readFile(parquet.path);
    assert.equal(bytes.toString('utf8', 0, 4), 'PAR1');
    assert.equal(bytes.toString('utf8', bytes.length - 4), 'PAR1');
    assert.ok(bytes.length > 16);
    const decoded = await parquetReadObjects({ file: await asyncBufferFromFile(parquet.path) });
    assert.equal(decoded.length, 2);
    assert.equal(decoded[0]?.['temperatureC'], 920.5);
    assert.equal(decoded[1]?.['uom'], '°C');
  } finally {
    await parquet.cleanup();
  }
});

test('a cancelled Parquet export stops before producing a download', async () => {
  const controller = new AbortController();
  async function* rows(): AsyncGenerator<TemperatureRow> {
    yield { time: '2026-09-23T12:00:00.000Z', temperatureC: 920.5, uom: '°C' };
    controller.abort();
    yield { time: '2026-09-23T12:00:01.000Z', temperatureC: 921, uom: '°C' };
  }
  await assert.rejects(prepareExportFile('parquet', rows(), controller.signal));
});
