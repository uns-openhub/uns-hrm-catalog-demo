import { defineDataCatalogField, defineDataCatalogSchema } from '@uns-kit/api';

export const temperatureRowFields = [
  defineDataCatalogField('time', 'string', 'Simulator measurement time.', {
    format: 'date-time',
    required: true,
    example: '2026-09-23T12:00:00.000Z',
  }),
  defineDataCatalogField('temperatureC', 'number', 'Measured furnace zone 1 temperature.', { required: true, example: 920.5 }),
  defineDataCatalogField('uom', 'string', 'Unit of measure.', { required: true, example: '°C' }),
];

export const parquetSchema = defineDataCatalogSchema({
  id: 'novasteel-zone-1-temperature-parquet',
  title: 'Furnace zone 1 Parquet columns',
  contentType: 'application/octet-stream',
  fields: temperatureRowFields,
});
