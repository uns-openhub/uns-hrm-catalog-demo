import '@uns-kit/api';
import { registerApiCatalog, type UnsProxyProcessWithApi } from '@uns-kit/api';
import { ConfigFile, logger, UnsClient, UnsProxyProcess } from '@uns-kit/core';
import { buildCatalog } from './temperature-catalog.js';

let activeProcess: UnsProxyProcess | undefined;

async function main(): Promise<void> {
  const config = await ConfigFile.loadConfig();
  if (!config.uns.jwksWellKnownUrl) {
    throw new Error('uns.jwksWellKnownUrl is required; the demo never uses a shared JWT secret.');
  }
  if (!config.uns.rest) {
    throw new Error('uns.rest is required for historical data access.');
  }

  const processName = config.uns.processName ?? 'uns-hrm-catalog-demo';
  const unsProcess = new UnsProxyProcess(config.infra.host ?? 'localhost', { processName }) as UnsProxyProcessWithApi;
  activeProcess = unsProcess;
  const api = await unsProcess.createApiProxy('catalog', {
    jwks: {
      wellKnownJwksUrl: config.uns.jwksWellKnownUrl,
      ...(config.uns.kidWellKnownUrl ? { activeKidUrl: config.uns.kidWellKnownUrl } : {}),
    },
  });
  const client = new UnsClient(config.uns.rest);

  await registerApiCatalog(api, {
    ...buildCatalog(client),
    context: undefined,
    options: {
      onError: ({ method, reqPath, error }) => logger.error(`Catalog handler error [${method} ${reqPath ?? ''}]:`, error),
    },
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void unsProcess.shutdown().catch((error: unknown) => logger.error('UNS shutdown failed:', error));
    });
  }
  logger.info(`Data Catalog demo '${processName}' registered.`);
}

void main().catch(async (error: unknown) => {
  logger.error('Data Catalog demo startup failed:', error);
  await activeProcess?.shutdown().catch((shutdownError: unknown) => logger.error('UNS shutdown failed:', shutdownError));
  process.exitCode = 1;
});
