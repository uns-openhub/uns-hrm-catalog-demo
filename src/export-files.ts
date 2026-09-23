import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileWriter, parquetWriteRows } from 'hyparquet-writer';
import { ExportError, type TemperatureRow } from './temperature-history.js';

export type PreparedFile = {
  path: string;
  fileName: string;
  bytes: number;
  cleanup: () => Promise<void>;
};

const MAX_FILE_BYTES = 128 * 1024 * 1024;

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function prepareExportFile(format: 'csv' | 'parquet', rows: AsyncIterable<TemperatureRow>): Promise<PreparedFile> {
  const directory = await mkdtemp(join(tmpdir(), 'uns-hrm-catalog-'));
  const fileName = `novasteel-furnace-zone-1-temperature.${format}`;
  const path = join(directory, fileName);
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    if (format === 'csv') {
      async function* lines(): AsyncGenerator<string> {
        yield 'time,temperatureC,uom\n';
        for await (const row of rows) {
          yield `${csvCell(row.time)},${csvCell(row.temperatureC)},${csvCell(row.uom)}\n`;
        }
      }
      await pipeline(Readable.from(lines()), createWriteStream(path));
    } else {
      async function* parquetRows(): AsyncGenerator<{ time: Date; temperatureC: number; uom: string }> {
        for await (const row of rows) {
          yield { time: new Date(row.time), temperatureC: row.temperatureC, uom: row.uom };
        }
      }
      await parquetWriteRows({
        writer: fileWriter(path),
        rows: parquetRows(),
        columns: [
          { name: 'time', type: 'TIMESTAMP' },
          { name: 'temperatureC', type: 'DOUBLE' },
          { name: 'uom', type: 'STRING' },
        ],
        rowGroupSize: 2_000,
      });
    }
    const { size } = await stat(path);
    if (size > MAX_FILE_BYTES) {
      throw new ExportError('Generated file exceeds the 128 MiB download safety limit; narrow the time range.', 413);
    }
    return { path, fileName, bytes: size, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
