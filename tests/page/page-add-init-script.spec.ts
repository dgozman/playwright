/**
 * Copyright 2018 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test as it, expect } from './pageTest';
import type { InitScriptSource } from '@playwright/test';

it('should evaluate before anything else on the page', async ({ page, server }) => {
  await page.addInitScript(function() {
    window['injected'] = 123;
  });
  await page.goto(server.PREFIX + '/tamperable.html');
  expect(await page.evaluate(() => window['result'])).toBe(123);
});

it('should work with a path', async ({ page, server, asset }) => {
  await page.addInitScript({ path: asset('injectedfile.js') });
  await page.goto(server.PREFIX + '/tamperable.html');
  expect(await page.evaluate(() => window['result'])).toBe(123);
});

it('should work with content @smoke', async ({ page, server }) => {
  await page.addInitScript({ content: 'window["injected"] = 123' });
  await page.goto(server.PREFIX + '/tamperable.html');
  expect(await page.evaluate(() => window['result'])).toBe(123);
});

it('should throw without path and content', async ({ page }) => {
  // @ts-expect-error foo is not a real option of addInitScript
  const error = await page.addInitScript({ foo: 'bar' }).catch(e => e);
  expect(error.message).toContain('Either path or content property must be present');
});

it('should work with trailing comments', async ({ page, asset }) => {
  await page.addInitScript({ content: '// comment' });
  await page.addInitScript({ content: 'window.secret = 42;' });
  await page.goto('data:text/html,<html></html>');
  expect(await page.evaluate('secret')).toBe(42);
});

it('should support multiple scripts', async ({ page, server }) => {
  await page.addInitScript(function() {
    window['script1'] = 1;
  });
  await page.addInitScript(function() {
    window['script2'] = 2;
  });
  await page.goto(server.PREFIX + '/tamperable.html');
  expect(await page.evaluate(() => window['script1'])).toBe(1);
  expect(await page.evaluate(() => window['script2'])).toBe(2);
});

it('should work with CSP', async ({ page, server }) => {
  server.setCSP('/empty.html', 'script-src ' + server.PREFIX);
  await page.addInitScript(function() {
    window['injected'] = 123;
  });
  await page.goto(server.PREFIX + '/empty.html');
  expect(await page.evaluate(() => window['injected'])).toBe(123);

  // Make sure CSP works.
  await page.addScriptTag({ content: 'window.e = 10;' }).catch(e => void e);
  expect(await page.evaluate(() => window['e'])).toBe(undefined);
});

it('should work after a cross origin navigation', async ({ page, server }) => {
  await page.goto(server.CROSS_PROCESS_PREFIX);
  await page.addInitScript(function() {
    window['injected'] = 123;
  });
  await page.goto(server.PREFIX + '/tamperable.html');
  expect(await page.evaluate(() => window['result'])).toBe(123);
});

it('init script should run only once in iframe', async ({ page, server, browserName }) => {
  it.info().annotations.push({ type: 'issue', description: 'https://github.com/microsoft/playwright/issues/26992' });
  const messages = [];
  page.on('console', event => {
    if (event.text().startsWith('init script:'))
      messages.push(event.text());
  });
  await page.addInitScript(() => console.log('init script:', location.pathname || 'no url yet'));
  await page.goto(server.PREFIX + '/frames/one-frame.html');
  expect(messages).toEqual([
    'init script: /frames/one-frame.html',
    'init script: ' + (browserName === 'firefox' ? 'no url yet' : '/frames/frame.html'),
  ]);
});

it('init script should run only once in popup', async ({ page, browserName }) => {
  await page.context().addInitScript(() => {
    window['callCount'] = (window['callCount'] || 0) + 1;
  });
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate(() => window.open('about:blank')),
  ]);
  expect(await popup.evaluate('callCount')).toEqual(1);
});

it('should work with function notation', async ({ page, server }) => {
  interface ExposedToThePage {
    add(a: number, b: number): Promise<number>;
    multiply(a: number, b: number): Promise<number>;
  }

  interface ExposedToTheTest {
    subtract(a: number, b: number): Promise<number>;
    divide(a: number, b: number): Promise<number>;
  }

  const logs: string[] = [];
  const push = logs.push.bind(logs);
  logs.push = (...items: string[]) => {
    console.log(...items);
    return push(...items);
  };
  page.on('console', message => logs.push(message.text()));

  const onConnect = async (exposedToTheTest: ExposedToTheTest, source: InitScriptSource) => {
    logs.push(`connected from ${source.frame.url()}`);

    const exposedToThePage: ExposedToThePage = {
      add: async (a, b) => a + b,
      multiply: async (a, b) => a * b,
    };

    logs.push(`subtract(1, 2) => ${await exposedToTheTest.subtract(1, 2)}`);
    logs.push(`divide(4, 2) => ${await exposedToTheTest.divide(4, 2)}`);
    return exposedToThePage;
  };

  await page.addInitScript(async connect => {
    const exposedToTheTest: ExposedToTheTest = {
      subtract: async (a, b) => a - b,
      divide: async (a, b) => a / b,
    };

    const exposedToThePage = await connect(exposedToTheTest);
    console.log(`add(1, 2) => ${await exposedToThePage.add(1, 2)}`);
    console.log(`multiply(2, 2) => ${await exposedToThePage.multiply(2, 2)}`);
  }, onConnect);

  await page.goto(server.EMPTY_PAGE);
  await expect.poll(() => logs.length).toEqual(5);
  expect(logs.sort()).toEqual([
    'add(1, 2) => 3',
    `connected from ${server.EMPTY_PAGE}`,
    'divide(4, 2) => 2',
    'multiply(2, 2) => 4',
    'subtract(1, 2) => -1',
  ]);
});

it('should work with simple function notation', async ({ page, server }) => {
  class Exposed {
    async add(a: number, b: number) {
      return a + b;
    }
  }

  const onConnect = async () => new Exposed();

  await page.addInitScript(async connect => {
    const exposed = await connect();
    console.log('add(1, 2) => ' + await exposed.add(1, 2));
  }, onConnect);

  const promise = page.waitForEvent('console');
  await page.goto(server.EMPTY_PAGE);
  const message = await promise;
  expect(message.text()).toBe('add(1, 2) => 3');
});
