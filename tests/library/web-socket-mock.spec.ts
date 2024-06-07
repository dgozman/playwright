/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { contextTest as test, expect } from '../config/browserTest';
import type { Page } from '@playwright/test';
import { mockWebSockets } from 'playwright-core/mocks/ws';

declare global {
  interface Window {
    ws: WebSocket;
    log: string[];
  }
}

async function setupWS(page: Page, port: number, binaryType: 'blob' | 'arraybuffer') {
  await page.goto('about:blank');
  await page.evaluate(({ port, binaryType }) => {
    window.log = [];
    window.ws = new WebSocket('ws://localhost:' + port + '/ws');
    window.ws.binaryType = binaryType;
    window.ws.addEventListener('open', () => window.log.push('open'));
    window.ws.addEventListener('close', event => window.log.push(`close code=${event.code} reason=${event.reason} wasClean=${event.wasClean}`));
    window.ws.addEventListener('error', event => window.log.push(`error`));
    window.ws.addEventListener('message', async event => {
      let data;
      if (typeof event.data === 'string')
        data = event.data;
      else if (event.data instanceof Blob)
        data = 'blob:' + await event.data.text();
      else
        data = 'arraybuffer:' + await (new Blob([event.data])).text();
      window.log.push(`message: data=${data} origin=${event.origin} lastEventId=${event.lastEventId}`);
    });
  }, { port, binaryType });
}

for (const mock of ['no-mock', 'fuse-mock', 'default-mock']) {
  test.describe(mock, async () => {
    test.beforeEach(async ({ page }) => {
      if (mock === 'default-mock') {
        await mockWebSockets(page, /zzz/, () => {});
      } else if (mock === 'fuse-mock') {
        await mockWebSockets(page, /.*/, route => {
          route.server.connect();
          route.client.addEventListener('message', event => {
            event.preventDefault();
            route.server.send(event.data);
          });
          route.server.addEventListener('message', event => {
            event.preventDefault();
            route.client.send(event.data);
          });
        });
      }
    });

    test('should work with text message', async ({ page, server }) => {
      const wsPromise = server.waitForWebSocket();
      const upgradePromise = server.waitForUpgrade();
      await setupWS(page, server.PORT, 'blob');
      expect(await page.evaluate(() => window.ws.readyState)).toBe(0);
      const { doUpgrade } = await upgradePromise;
      expect(await page.evaluate(() => window.ws.readyState)).toBe(0);
      expect(await page.evaluate(() => window.log)).toEqual([]);
      doUpgrade();
      await expect.poll(() => page.evaluate(() => window.ws.readyState)).toBe(1);
      expect(await page.evaluate(() => window.log)).toEqual(['open']);
      const ws = await wsPromise;
      ws.send('hello');
      await expect.poll(() => page.evaluate(() => window.log)).toEqual([
        'open',
        `message: data=hello origin=ws://localhost:${server.PORT} lastEventId=`,
      ]);
      expect(await page.evaluate(() => window.ws.readyState)).toBe(1);
      const messagePromise = new Promise(f => ws.once('message', data => f(data.toString())));
      await page.evaluate(() => window.ws.send('hi'));
      expect(await messagePromise).toBe('hi');
      ws.close(1008, 'oops');
      await expect.poll(() => page.evaluate(() => window.ws.readyState)).toBe(3);
      expect(await page.evaluate(() => window.log)).toEqual([
        'open',
        `message: data=hello origin=ws://localhost:${server.PORT} lastEventId=`,
        'close code=1008 reason=oops wasClean=true',
      ]);
    });

    test('should work with binaryType=blob', async ({ page, server }) => {
      const wsPromise = server.waitForWebSocket();
      await setupWS(page, server.PORT, 'blob');
      const ws = await wsPromise;
      ws.send(Buffer.from('hi'));
      await expect.poll(() => page.evaluate(() => window.log)).toEqual([
        'open',
        `message: data=blob:hi origin=ws://localhost:${server.PORT} lastEventId=`,
      ]);
      const messagePromise = new Promise(f => ws.once('message', data => f(data.toString())));
      await page.evaluate(() => window.ws.send(new Blob([new Uint8Array(['h'.charCodeAt(0), 'i'.charCodeAt(0)])])));
      expect(await messagePromise).toBe('hi');
    });

    test('should work with binaryType=arraybuffer', async ({ page, server }) => {
      const wsPromise = server.waitForWebSocket();
      await setupWS(page, server.PORT, 'arraybuffer');
      const ws = await wsPromise;
      ws.send(Buffer.from('hi'));
      await expect.poll(() => page.evaluate(() => window.log)).toEqual([
        'open',
        `message: data=arraybuffer:hi origin=ws://localhost:${server.PORT} lastEventId=`,
      ]);
      const messagePromise = new Promise(f => ws.once('message', data => f(data.toString())));
      await page.evaluate(() => window.ws.send(new Uint8Array(['h'.charCodeAt(0), 'i'.charCodeAt(0)]).buffer));
      expect(await messagePromise).toBe('hi');
    });

    test('should work when connection errors out', async ({ page, server, browserName }) => {
      test.skip(browserName === 'webkit', 'WebKit ignores the connection error and fires no events!');

      const upgradePromise = server.waitForUpgrade();
      await setupWS(page, server.PORT, 'blob');
      const { socket } = await upgradePromise;
      expect(await page.evaluate(() => window.ws.readyState)).toBe(0);
      expect(await page.evaluate(() => window.log)).toEqual([]);
      socket.destroy();
      await expect.poll(() => page.evaluate(() => window.ws.readyState)).toBe(3);
      expect(await page.evaluate(() => window.log)).toEqual([
        'error',
        expect.stringMatching(/close code=\d+ reason= wasClean=false/),
      ]);
    });

    test('should work with error after successful open', async ({ page, server, browserName }) => {
      test.skip(browserName === 'firefox', 'Firefox does not close the websocket upon a bad frame');

      const upgradePromise = server.waitForUpgrade();
      await setupWS(page, server.PORT, 'blob');
      const { socket, doUpgrade } = await upgradePromise;
      doUpgrade();
      await expect.poll(() => page.evaluate(() => window.ws.readyState)).toBe(1);
      expect(await page.evaluate(() => window.log)).toEqual(['open']);
      socket.write('garbage');
      await expect.poll(() => page.evaluate(() => window.ws.readyState)).toBe(3);
      expect(await page.evaluate(() => window.log)).toEqual([
        'open',
        'error',
        expect.stringMatching(/close code=\d+ reason= wasClean=false/),
      ]);
    });

    test('should work with client-side close', async ({ page, server }) => {
      const wsPromise = server.waitForWebSocket();
      const upgradePromise = server.waitForUpgrade();
      await setupWS(page, server.PORT, 'blob');
      expect(await page.evaluate(() => window.ws.readyState)).toBe(0);
      const { doUpgrade } = await upgradePromise;
      expect(await page.evaluate(() => window.ws.readyState)).toBe(0);
      expect(await page.evaluate(() => window.log)).toEqual([]);
      doUpgrade();
      await expect.poll(() => page.evaluate(() => window.ws.readyState)).toBe(1);
      expect(await page.evaluate(() => window.log)).toEqual(['open']);
      const ws = await wsPromise;
      const closedPromise = new Promise<{ code: number, reason: Buffer }>(f => ws.once('close', (code, reason) => f({ code, reason })));
      const readyState = await page.evaluate(() => {
        window.ws.close(3002, 'oops');
        return window.ws.readyState;
      });
      expect(readyState).toBe(2);
      await expect.poll(() => page.evaluate(() => window.ws.readyState)).toBe(3);
      expect(await page.evaluate(() => window.log)).toEqual([
        'open',
        'close code=3002 reason=oops wasClean=true',
      ]);
      const closed = await closedPromise;
      expect(closed.code).toBe(3002);
      expect(closed.reason.toString()).toBe('oops');
    });
  });
}

test('should work with server', async ({ page, server }) => {
  let resolve;
  const promise = new Promise<WebSocket>(f => resolve = f);
  await mockWebSockets(page, /.*/, ({ client, server }) => {
    server.connect();
    client.addEventListener('message', event => {
      switch (event.data) {
        case 'to-respond':
          event.preventDefault();
          client.send('response');
          return;
        case 'to-block':
          event.preventDefault();
          return;
        case 'to-modify':
          event.preventDefault();
          server.send('modified');
          return;
      }
    });
    server.addEventListener('message', event => {
      switch (event.data) {
        case 'to-block':
          event.preventDefault();
          return;
        case 'to-modify':
          event.preventDefault();
          client.send('modified');
          return;
      }
    });
    server.send('fake');
    resolve(client);
  });

  const wsPromise = server.waitForWebSocket();
  let log: string[] = [];
  server.onceWebSocketConnection(ws => {
    ws.on('message', data => log.push(`message: ${data.toString()}`));
    ws.on('close', (code, reason) => log.push(`close: code=${code} reason=${reason.toString()}`));
  });

  await setupWS(page, server.PORT, 'blob');
  const ws = await wsPromise;
  await expect.poll(() => log).toEqual(['message: fake']);

  ws.send('to-modify');
  ws.send('to-block');
  ws.send('pass-server');
  await expect.poll(() => page.evaluate(() => window.log)).toEqual([
    'open',
    `message: data=modified origin=ws://localhost:${server.PORT} lastEventId=`,
    `message: data=pass-server origin=ws://localhost:${server.PORT} lastEventId=`,
  ]);

  await page.evaluate(() => {
    window.ws.send('to-respond');
    window.ws.send('to-modify');
    window.ws.send('to-block');
    window.ws.send('pass-client');
  });
  await expect.poll(() => log).toEqual(['message: fake', 'message: modified', 'message: pass-client']);
  await expect.poll(() => page.evaluate(() => window.log)).toEqual([
    'open',
    `message: data=modified origin=ws://localhost:${server.PORT} lastEventId=`,
    `message: data=pass-server origin=ws://localhost:${server.PORT} lastEventId=`,
    `message: data=response origin=ws://localhost:${server.PORT} lastEventId=`,
  ]);

  const client = await promise;
  client.send('another');
  await expect.poll(() => page.evaluate(() => window.log)).toEqual([
    'open',
    `message: data=modified origin=ws://localhost:${server.PORT} lastEventId=`,
    `message: data=pass-server origin=ws://localhost:${server.PORT} lastEventId=`,
    `message: data=response origin=ws://localhost:${server.PORT} lastEventId=`,
    `message: data=another origin=ws://localhost:${server.PORT} lastEventId=`,
  ]);

  await page.evaluate(() => {
    window.ws.send('pass-client-2');
    window.ws.close(3009, 'problem');
  });
  await expect.poll(() => log).toEqual([
    'message: fake',
    'message: modified',
    'message: pass-client',
    'message: pass-client-2',
    'close: code=3009 reason=problem',
  ]);
});

test('should work without server', async ({ page, server }) => {
  let resolve;
  const promise = new Promise<WebSocket>(f => resolve = f);
  await mockWebSockets(page, /.*/, ({ client, server }) => {
    client.addEventListener('message', event => {
      switch (event.data) {
        case 'to-respond':
          client.send('response');
          return;
      }
    });
    resolve(client);
  });

  await setupWS(page, server.PORT, 'blob');

  await page.evaluate(() => {
    window.ws.send('to-respond');
    window.ws.send('to-block');
    window.ws.send('to-respond');
  });

  await expect.poll(() => page.evaluate(() => window.log)).toEqual([
    'open',
    `message: data=response origin=ws://localhost:${server.PORT} lastEventId=`,
    `message: data=response origin=ws://localhost:${server.PORT} lastEventId=`,
  ]);

  const client = await promise;
  client.send('another');
  client.close(3008, 'oops');
  await expect.poll(() => page.evaluate(() => window.log)).toEqual([
    'open',
    `message: data=response origin=ws://localhost:${server.PORT} lastEventId=`,
    `message: data=response origin=ws://localhost:${server.PORT} lastEventId=`,
    `message: data=another origin=ws://localhost:${server.PORT} lastEventId=`,
    'close code=3008 reason=oops wasClean=true',
  ]);
});

test('should work with server.close', async ({ page, server }) => {
  let resolve;
  const promise = new Promise<{ c: WebSocket, s: WebSocket }>(f => resolve = f);
  await mockWebSockets(page, /.*/, ({ client, server }) => {
    server.connect();
    resolve({ c: client, s: server });
  });

  const wsPromise = server.waitForWebSocket();
  await setupWS(page, server.PORT, 'blob');
  const { c, s } = await promise;
  const ws = await wsPromise;

  c.send('hello');
  await expect.poll(() => page.evaluate(() => window.log)).toEqual([
    'open',
    `message: data=hello origin=ws://localhost:${server.PORT} lastEventId=`,
  ]);

  const closedPromise = new Promise(f => ws.once('close', (code, reason) => f({ code, reason: reason.toString() })));
  s.close(3009, 'oops');
  await expect.poll(() => page.evaluate(() => window.log)).toEqual([
    'open',
    `message: data=hello origin=ws://localhost:${server.PORT} lastEventId=`,
    'close code=3009 reason=oops wasClean=true',
  ]);
  expect(await closedPromise).toEqual({ code: 3009, reason: 'oops' });
});

test('should emit close upon frame navigation', async ({ page, server }) => {
  let resolve;
  const promise = new Promise<{ c: WebSocket, s: WebSocket }>(f => resolve = f);
  await mockWebSockets(page, /.*/, ({ client, server }) => {
    server.connect();
    resolve({ c: client, s: server });
  });

  await setupWS(page, server.PORT, 'blob');
  const { c, s } = await promise;

  c.send('hello');
  await expect.poll(() => page.evaluate(() => window.log)).toEqual([
    'open',
    `message: data=hello origin=ws://localhost:${server.PORT} lastEventId=`,
  ]);

  const clientClosedPromise = new Promise<CloseEvent>(f => c.addEventListener('close', f));
  const serverClosedPromise = new Promise<CloseEvent>(f => s.addEventListener('close', f));
  await page.goto(server.EMPTY_PAGE);

  const clientClosed = await clientClosedPromise;
  expect(clientClosed.code).toBe(undefined);
  expect(clientClosed.reason).toBe(undefined);

  const serverClosed = await serverClosedPromise;
  expect(serverClosed.code).toBe(undefined);
  expect(serverClosed.reason).toBe(undefined);
});

test('should pattern match', async ({ page, server }) => {
  await mockWebSockets(page, /.*\/ws$/, ({ client, server }) => {
    server.connect();
  });
  await mockWebSockets(page, '**/mock-ws', ({ client, server }) => {
    client.addEventListener('message', () => {
      client.send('mock-response');
    });
  });

  const wsPromise = server.waitForWebSocket();

  await page.goto('about:blank');
  await page.evaluate(({ port }) => {
    window.log = [];
    (window as any).ws1 = new WebSocket('ws://localhost:' + port + '/ws');
    (window as any).ws1.addEventListener('message', event => window.log.push(`ws1:${event.data}`));
    (window as any).ws2 = new WebSocket('ws://localhost:' + port + '/something/something/mock-ws');
    (window as any).ws2.addEventListener('message', event => window.log.push(`ws2:${event.data}`));
  }, { port: server.PORT });

  const ws = await wsPromise;
  ws.on('message', () => ws.send('response'));

  await page.evaluate(() => (window as any).ws1.send('request'));
  await expect.poll(() => page.evaluate(() => window.log)).toEqual([`ws1:response`]);

  await page.evaluate(() => (window as any).ws2.send('request'));
  await expect.poll(() => page.evaluate(() => window.log)).toEqual([`ws1:response`, `ws2:mock-response`]);
});
