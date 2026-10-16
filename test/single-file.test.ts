import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDataCatalogOffersFromSources, type ApiHandler } from '@uns-kit/api';
import type { UnsClient } from '@uns-kit/core';
import { createPreviewSource } from '../examples/single-file.js';

const query = { from: '2026-09-23T12:00:00Z', to: '2026-09-23T13:00:00Z' };
const row = { time: '2026-09-23T12:00:00Z', numberValue: 920.5, uom: '°C' };

function fixture(records: Record<string, unknown>[] = [row], truncated = false, error: string | null = null) {
  const calls: { topic: string; options: unknown }[] = [];
  const client = {
    async history(topic: string, options: unknown) {
      calls.push({ topic, options });
      return { results: [{ data: records, stats: { truncated }, error, toRecords: () => records }] };
    },
  } as unknown as Pick<UnsClient, 'history'>;
  return { source: createPreviewSource(client), calls };
}

async function request(source: ReturnType<typeof createPreviewSource>, input: unknown = query, authorization = 'Bearer caller-token') {
  let status = 200;
  let body: any;
  const res = {
    status(value: number) {
      status = value;
      return res;
    },
    json(value: unknown) {
      body = value;
    },
  };
  await source.handler(
    { req: { query: input, headers: { authorization } }, res } as unknown as Parameters<ApiHandler<'GET'>>[0],
    undefined,
  );
  return { status, body };
}

test('single-file source builds a usable offer and reads raw history with the caller token', async () => {
  const { source, calls } = fixture();
  const offers = buildDataCatalogOffersFromSources({ temperature: source });
  assert.equal(offers.length, 1);
  assert.equal(
    offers[0]?.operations[0]?.path,
    '/api/forge-group/novasteel/hot-rolling/hrm-pusher-furnace/dataset/zone-1-temperature-example/json',
  );
  const result = await request(source);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    count: 1,
    hasMore: false,
    data: [{ time: '2026-09-23T12:00:00.000Z', temperatureC: 920.5, uom: '°C' }],
  });
  assert.deepEqual(calls, [
    {
      topic: 'forge-group/novasteel/hot-rolling/hrm-pusher-furnace/equipment/zone-1/temperature',
      options: { from: '2026-09-23T12:00:00.000Z', to: '2026-09-23T13:00:00.000Z', limit: 101, dedupe: false, token: 'caller-token' },
    },
  ]);
});

test('single-file preview is bounded and reports both extra rows and upstream truncation', async () => {
  const full = await request(fixture(Array.from({ length: 101 }, () => row)).source);
  assert.equal(full.body.count, 100);
  assert.equal(full.body.data.length, 100);
  assert.equal(full.body.hasMore, true);
  const truncated = await request(fixture([row], true).source);
  assert.equal(truncated.body.hasMore, true);
  assert.deepEqual((await request(fixture([]).source)).body, { count: 0, hasMore: false, data: [] });
});

test('invalid ranges and missing caller tokens never read history', async () => {
  const { source, calls } = fixture();
  for (const input of [
    {},
    { ...query, from: '2026-09-23' },
    { ...query, from: '2026-09-23T12:00:00' },
    { ...query, from: '2026-09-24T12:00:00Z' },
    { ...query, to: '2026-10-01T13:00:00Z' },
  ])
    assert.equal((await request(source, input)).status, 400);
  for (const header of ['', 'Basic example', 'Bearer']) {
    assert.equal((await request(source, query, header)).status, 401);
  }
  assert.equal(calls.length, 0);
});

test('unavailable or malformed history fails explicitly', async () => {
  for (const source of [
    fixture([], false, 'backend unavailable').source,
    fixture([{ ...row, numberValue: null }]).source,
    fixture([{ ...row, time: 'invalid' }]).source,
    createPreviewSource({ history: async () => ({ results: [] }) } as unknown as Pick<UnsClient, 'history'>),
    createPreviewSource({
      history: async () => {
        throw new Error('private backend details');
      },
    } as unknown as Pick<UnsClient, 'history'>),
  ]) {
    assert.deepEqual(await request(source), { status: 502, body: { error: 'Temperature history is unavailable or invalid.' } });
  }
});
