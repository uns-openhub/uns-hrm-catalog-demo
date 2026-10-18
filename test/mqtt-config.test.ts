import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { mqttChannelParameters, resolveMqttChannel } from '@uns-kit/core';

test('Catalog entry passes the shared resolved MQTT channel into the process', async () => {
  for (const entry of ['../src/index.ts', '../examples/single-file.ts']) {
  const source = await readFile(new URL(entry, import.meta.url), 'utf8');
  assert.match(source, /const channel = resolveMqttChannel\(config.infra as MqttChannelConfig\)/);
  assert.match(source, /new UnsProxyProcess\(channel.host, \{[\s\S]*?\.\.\.mqttChannelParameters\(channel\)/);
  }
});

test('default and configured broker ports preserve connection security settings', () => {
  assert.equal(resolveMqttChannel({ host: 'localhost' }).host, 'localhost');
  const channel = resolveMqttChannel({ host: 'localhost', port: 1889, username: 'fixture', password: 'local-only', rejectUnauthorized: true });
  const options = mqttChannelParameters(channel);
  assert.equal(options.port, 1889);
  assert.equal(options.username, 'fixture');
  assert.equal(options.password, 'local-only');
  assert.equal(options.rejectUnauthorized, true);
});
