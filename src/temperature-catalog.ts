import { createReadStream } from 'node:fs';
import {
  buildDataCatalogOfferOperation,
  defineDataCatalogField,
  defineDataCatalogOfferSource,
  defineDataCatalogQueryParam,
  defineDataCatalogSchema,
  defineServiceApi,
  type DataCatalogOfferRegistration,
  type DataCatalogOfferSourceRegistration,
  type ServiceApiRegistration,
} from '@uns-kit/api';
import type { UnsClient } from '@uns-kit/core';
import { prepareExportFile } from './export-files.js';
import {
  ExportError,
  PREVIEW_SIZE,
  SOURCE_TOPIC,
  exportTemperatureRows,
  parseTimeRange,
  readWindow,
  requireBearer,
} from './temperature-history.js';
import { parquetSchema, temperatureRowFields } from './temperature-schema.js';

type ApiHandler = (event: any) => Promise<void>;
const OFFER_ID = 'novasteel-furnace-zone-1-temperature';
const routeBase = {
  topic: 'forge-group/novasteel/hot-rolling/',
  asset: 'hrm-pusher-furnace',
  objectType: 'dataset',
  objectId: 'zone-1-temperature',
};
const routes = {
  json: { ...routeBase, attribute: 'json' },
  csv: { ...routeBase, attribute: 'csv' },
  parquet: { ...routeBase, attribute: 'parquet' },
};
const queryParams = [
  defineDataCatalogQueryParam('from', 'Inclusive start (ISO 8601 timestamp with timezone).', { required: true, format: 'date-time' }),
  defineDataCatalogQueryParam('to', 'Inclusive end (ISO 8601 timestamp with timezone); maximum seven days after from.', {
    required: true,
    format: 'date-time',
  }),
];
const jsonSchema = defineDataCatalogSchema({
  id: 'novasteel-zone-1-temperature-preview',
  title: 'Furnace zone 1 temperature preview',
  contentType: 'application/json',
  description: 'At most 500 rows for browser inspection. hasMore indicates that the range contains more rows.',
  fields: [
    defineDataCatalogField('count', 'integer', 'Rows in this preview.', { required: true, example: 1 }),
    defineDataCatalogField('hasMore', 'boolean', 'More rows exist in the selected range.', { required: true, example: false }),
    defineDataCatalogField('data', 'array', 'Temperature rows.', { required: true }),
    ...temperatureRowFields,
  ],
  examplePayloads: [{ count: 1, hasMore: false, data: [{ time: '2026-09-23T12:00:00.000Z', temperatureC: 920.5, uom: '°C' }] }],
});
const csvSchema = defineDataCatalogSchema({
  id: 'novasteel-zone-1-temperature-csv',
  title: 'Furnace zone 1 CSV columns',
  contentType: 'text/csv',
  fields: temperatureRowFields,
});

function sendError(event: any, error: unknown): void {
  const status = error instanceof ExportError ? error.status : 502;
  const message = error instanceof ExportError ? error.message : 'Temperature history could not be exported.';
  event.res.status(status).json({ error: message });
}

let activeFileExports = 0;
const MAX_CONCURRENT_FILE_EXPORTS = 2;

function fileHandler(client: UnsClient, format: 'csv' | 'parquet'): ApiHandler {
  return async (event) => {
    if (activeFileExports >= MAX_CONCURRENT_FILE_EXPORTS) {
      event.res.status(429).json({ error: 'Two file exports are already running; retry shortly.' });
      return;
    }
    activeFileExports++;
    const abortController = new AbortController();
    const onDisconnect = () => abortController.abort();
    event.res.once('close', onDisconnect);
    let released = false;
    const release = () => {
      if (!released) {
        activeFileExports--;
        released = true;
      }
    };
    try {
      const range = parseTimeRange(event.req.query ?? {});
      const token = requireBearer(event.req.headers ?? {});
      const prepared = await prepareExportFile(
        format,
        exportTemperatureRows(client, range, token, abortController.signal),
        abortController.signal,
      );
      if (abortController.signal.aborted) {
        await prepared.cleanup();
        release();
        return;
      }
      const stream = createReadStream(prepared.path);
      const finish = () => {
        release();
        void prepared.cleanup();
      };
      stream.once('close', finish);
      stream.once('error', (error) => event.res.destroy(error));
      event.res.once('close', () => stream.destroy());
      event.res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/octet-stream');
      event.res.setHeader('Content-Disposition', `attachment; filename="${prepared.fileName}"`);
      event.res.setHeader('Content-Length', String(prepared.bytes));
      stream.pipe(event.res);
    } catch (error) {
      release();
      if (!abortController.signal.aborted && !event.res.destroyed) sendError(event, error);
    } finally {
      event.res.off('close', onDisconnect);
    }
  };
}

export function buildCatalog(client: UnsClient): {
  serviceApis: Record<string, ServiceApiRegistration<ApiHandler>>;
  dataOfferSources: Record<string, DataCatalogOfferSourceRegistration<ApiHandler>>;
  dataCatalogOffers: DataCatalogOfferRegistration[];
} {
  const serviceApis = {
    status: defineServiceApi<ApiHandler>({
      attribute: 'status',
      method: 'GET',
      description: 'Data Catalog demo process status.',
      handler: async (event) => event.res.json({ status: 'ok', sourceTopic: SOURCE_TOPIC }),
    }),
  };
  const sourceMeta = {
    offerId: OFFER_ID,
    displayName: 'Novasteel furnace zone 1 temperature',
    description: 'Historical temperature measurements from one rtt-demo-app attribute.',
    owner: 'UNS OpenHub',
    tags: ['demo', 'hot-rolling', 'temperature'],
    method: 'GET' as const,
    queryParams,
  };
  const dataOfferSources = {
    json: defineDataCatalogOfferSource<ApiHandler>({
      ...sourceMeta,
      ...routes.json,
      schema: jsonSchema,
      response: { statusCode: '200', contentType: 'application/json' },
      handler: async (event) => {
        try {
          const range = parseTimeRange(event.req.query ?? {});
          const token = requireBearer(event.req.headers ?? {});
          const page = await readWindow(client, range, token, PREVIEW_SIZE + 1);
          event.res.json({
            count: Math.min(page.rows.length, PREVIEW_SIZE),
            hasMore: page.truncated || page.rows.length > PREVIEW_SIZE,
            data: page.rows.slice(0, PREVIEW_SIZE),
          });
        } catch (error) {
          sendError(event, error);
        }
      },
    }),
    csv: defineDataCatalogOfferSource<ApiHandler>({
      ...sourceMeta,
      ...routes.csv,
      schema: csvSchema,
      response: { statusCode: '200', contentType: 'text/csv' },
      handler: fileHandler(client, 'csv'),
    }),
    parquet: defineDataCatalogOfferSource<ApiHandler>({
      ...sourceMeta,
      ...routes.parquet,
      schema: parquetSchema,
      response: { statusCode: '200', contentType: 'application/octet-stream' },
      handler: fileHandler(client, 'parquet'),
    }),
  };
  const operation = (format: keyof typeof routes, contentType: string, schema: typeof jsonSchema) =>
    buildDataCatalogOfferOperation(routes[format], {
      id: `${OFFER_ID}-${format}`,
      method: 'GET',
      summary: `${format.toUpperCase()} ${format === 'json' ? 'preview' : 'export'}`,
      description:
        format === 'json'
          ? 'Inspect up to 500 rows in the browser.'
          : 'Download all available rows in the selected window, without silent truncation.',
      parameters: queryParams,
      responses: [{ statusCode: '200', contentType, schemas: [schema] }],
    });
  const dataCatalogOffers = [
    {
      offerId: OFFER_ID,
      displayName: sourceMeta.displayName,
      description: sourceMeta.description,
      owner: sourceMeta.owner,
      status: 'available',
      tags: sourceMeta.tags,
      schemas: [jsonSchema, csvSchema, parquetSchema],
      operations: [
        operation('json', 'application/json', jsonSchema),
        operation('csv', 'text/csv', csvSchema),
        operation('parquet', 'application/octet-stream', parquetSchema),
      ],
      metadata: { sourceTopic: SOURCE_TOPIC, sourceMicroservice: 'rtt-demo-app' },
    },
  ] satisfies DataCatalogOfferRegistration[];
  return { serviceApis, dataOfferSources, dataCatalogOffers };
}
