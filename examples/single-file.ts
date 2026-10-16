/** Minimal Data Catalog service. Run with `pnpm run example:single-file`. */
import { pathToFileURL } from 'node:url';
import {
  defineDataCatalogField,
  defineDataCatalogOfferSource,
  defineDataCatalogQueryParam,
  defineDataCatalogSchema,
  registerApiCatalog,
  type ApiHandler,
  type UnsProxyProcessWithApi,
} from '@uns-kit/api';
import { ConfigFile, logger, UnsClient, UnsProxyProcess } from '@uns-kit/core';

// 1. Choose one source. This public example always uses fictional simulator data.
const SOURCE_TOPIC = 'forge-group/novasteel/hot-rolling/hrm-pusher-furnace/equipment/zone-1/temperature';
const PREVIEW_SIZE = 100;
const MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

// 2. Describe the route, catalog entry and response. The SDK builds the offer.
export function createPreviewSource(client: Pick<UnsClient, 'history'>) {
  return defineDataCatalogOfferSource<ApiHandler<'GET'>>({
    offerId: 'novasteel-temperature-single-file-example',
    displayName: 'Furnace temperature — single-file example',
    description: 'Preview up to 100 raw zone 1 measurements; hasMore signals additional rows.',
    topic: 'forge-group/novasteel/hot-rolling/',
    asset: 'hrm-pusher-furnace',
    objectType: 'dataset',
    objectId: 'zone-1-temperature-example',
    attribute: 'json',
    method: 'GET',
    queryParams: ['from', 'to'].map((name) =>
      defineDataCatalogQueryParam(name, 'Inclusive ISO 8601 timestamp with timezone; maximum range seven days.', {
        required: true,
        format: 'date-time',
      }),
    ),
    response: { statusCode: '200', contentType: 'application/json' },
    schema: defineDataCatalogSchema({
      id: 'single-file-temperature-preview',
      title: 'Bounded temperature preview',
      contentType: 'application/json',
      fields: [
        defineDataCatalogField('count', 'integer', 'Number of returned rows.'),
        defineDataCatalogField('hasMore', 'boolean', 'The selected range contains more rows.'),
        defineDataCatalogField('data', 'array', 'Temperature measurements.'),
        defineDataCatalogField('time', 'string', 'Measurement timestamp.', { path: 'data[].time', format: 'date-time' }),
        defineDataCatalogField('temperatureC', 'number', 'Temperature in degrees Celsius.', { path: 'data[].temperatureC' }),
        defineDataCatalogField('uom', 'string', 'Unit of measure.', { path: 'data[].uom' }),
      ],
    }),

    // 3. Validate input and read as the caller, preserving their topic permissions.
    handler: async ({ req, res }) => {
      const parseDate = (value: unknown): number =>
        typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
      const from = parseDate(req.query?.['from']);
      const to = parseDate(req.query?.['to']);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > MAX_RANGE_MS) {
        res.status(400).json({ error: 'Provide from/to timestamps with timezones, in order and at most seven days apart.' });
        return;
      }
      const authorization = req.headers['authorization'];
      const token = typeof authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1] : undefined;
      if (!token) {
        res.status(401).json({ error: 'A bearer token is required.' });
        return;
      }
      try {
        const result = await client.history(SOURCE_TOPIC, {
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          limit: PREVIEW_SIZE + 1,
          dedupe: false, // Request raw measurements, including repeated values.
          token,
        });
        const item = result?.results[0];
        if (!item || item.error) throw new Error('History query failed.');
        const records = item.toRecords();
        const data = records.slice(0, PREVIEW_SIZE).map((record) => {
          const rawTime = record['time'] ?? record['timestamp'];
          const time = new Date(rawTime instanceof Date ? rawTime : String(rawTime ?? '')).toISOString();
          const value = record['numberValue'] ?? record['value'];
          if (value == null || value === '' || !Number.isFinite(Number(value))) throw new Error('Invalid temperature.');
          return { time, temperatureC: Number(value), uom: record['uom'] ?? '°C' };
        });
        res.json({ count: data.length, hasMore: item.stats?.['truncated'] === true || records.length > PREVIEW_SIZE, data });
      } catch {
        res.status(502).json({ error: 'Temperature history is unavailable or invalid.' });
      }
    },
  });
}

// 4. Start a JWKS-protected API and register the source in Data Catalog.
let activeProcess: UnsProxyProcess | undefined;
async function main(): Promise<void> {
  const config = await ConfigFile.loadConfig();
  if (!config.uns.jwksWellKnownUrl || !config.uns.rest) {
    throw new Error('Configure uns.jwksWellKnownUrl and uns.rest before starting the example.');
  }
  const unsProcess = new UnsProxyProcess(config.infra.host ?? 'localhost', {
    processName: 'uns-hrm-single-file-example',
  }) as UnsProxyProcessWithApi;
  activeProcess = unsProcess;
  const api = await unsProcess.createApiProxy('catalog', {
    jwks: {
      wellKnownJwksUrl: config.uns.jwksWellKnownUrl,
      ...(config.uns.kidWellKnownUrl ? { activeKidUrl: config.uns.kidWellKnownUrl } : {}),
    },
  });
  await registerApiCatalog(api, {
    dataOfferSources: { temperature: createPreviewSource(new UnsClient(config.uns.rest)) },
    context: undefined,
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void unsProcess.shutdown().catch((error: unknown) => logger.error('Example shutdown failed:', error));
    });
  }
  logger.info('Single-file example registered in Data Catalog.');
}

// Importing the source for tests does not start the service.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(async (error: unknown) => {
    logger.error('Single-file example startup failed:', error);
    await activeProcess?.shutdown().catch((shutdownError: unknown) => logger.error('Example shutdown failed:', shutdownError));
    process.exitCode = 1;
  });
}
