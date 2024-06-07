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

import type { Page, BrowserContext, Frame } from '../../../types/types';
import type { EvalRequest } from './injected/webSocketInjected';
import * as webSocketInjectedSource from './generated/webSocketInjectedSource';
import { type WebSocketMessage, WebSocketMock, dataToMessage, messageToData } from './injected/webSocketMock';
import { urlMatches } from '../../utils/network';

interface ClientWebSocket extends WebSocket {}
interface ServerWebSocket extends WebSocket {
  connect(): void;
}

export interface WebSocketRoute {
  readonly client: ClientWebSocket;
  readonly server: ServerWebSocket;
}

const installedSymbol = Symbol('installed');
const handlersSymbol = Symbol('wshandlers');
const routesSymbol = Symbol('wsroutes');
type Handler = { pattern: string | RegExp, callback: (route: WebSocketRoute) => any };
const idToRoute = new Map<string, WebSocketRouteImpl>();

export async function mockWebSockets(where: Page | BrowserContext, pattern: string | RegExp, handler: (route: WebSocketRoute) => any) {
  // Note: install for the whole context right away.
  const context = (where as Page).keyboard ? (where as Page).context() : where as BrowserContext;
  if (!(context as any)[installedSymbol]) {
    (context as any)[installedSymbol] = true;
    await installOnContext(context);
  }

  const handlers = (where as any)[handlersSymbol] as Handler[] | undefined;
  if (handlers)
    handlers.push({ pattern, callback: handler });
  else
    (where as any)[handlersSymbol] = [{ pattern, callback: handler }];
}

async function installOnContext(context: BrowserContext) {
  await context.exposeBinding('__pwWebSocketBinding', (source, request) => {
    if (request.type === 'onConnect') {
      const pageHandlers = ((source.page as any)[handlersSymbol] || []) as Handler[];
      const contextHandlers = ((source.context as any)[handlersSymbol] || []) as Handler[];
      const handlers = [...pageHandlers, ...contextHandlers];
      const route = new WebSocketRouteImpl(source.frame, request.id, request.url);

      for (const { pattern, callback } of handlers) {
        if (urlMatches((context as any)._options.baseURL, request.url, pattern)) {
          callback(route);
          route._sendEnsureOpened();
          return;
        }
      }

      route.server.connect();
      return;
    }

    const route = idToRoute.get(request.id);
    if (!route)
      return;
    if (request.type === 'onSend')
      route._onSend(dataToMessage(request.data, route.client.binaryType));
    if (request.type === 'onClose')
      route._onClose(request.code, request.reason, request.wasClean);
    if (request.type === 'onCleanup')
      route._onCleanup();
    if (request.type === 'onWSMessage')
      route._onWSMessage(dataToMessage(request.data, route.server.binaryType));
    if (request.type === 'onWSClose')
      route._onWSClose(request.code, request.reason, request.wasClean);
    if (request.type === 'onWSError')
      route._onWSError();
  });

  await context.addInitScript(`(() => {
    const module = {};
    ${webSocketInjectedSource.source}
    module.exports.inject()(globalThis);
  })();`);

  // When the frame navigates, there will be no communication from the mock websocket anymore,
  // so pretend like it was closed.
  const onFrameNavigated = (frame: Frame) => {
    const list = ((frame as any)[routesSymbol] || []) as WebSocketRouteImpl[];
    list.forEach(route => route._frameNavigatedAway());
  };
  const installFrameNavigatedListener = (page: Page) => page.on('framenavigated', onFrameNavigated);
  context.on('page', installFrameNavigatedListener);
  context.pages().forEach(installFrameNavigatedListener);
}

class WebSocketRouteImpl implements WebSocketRoute {
  private _id: string;
  private _frame: Frame;
  private _client: WebSocketMock;
  private _server: WebSocketMock;

  readonly client: ClientWebSocket;
  readonly server: ServerWebSocket;

  constructor(frame: Frame, id: string, url: string) {
    this._id = id;
    this._frame = frame;

    idToRoute.set(id, this);
    const list = (frame as any)[routesSymbol] || [];
    list.push(this);
    (frame as any)[routesSymbol] = list;

    this._client = new WebSocketMock(url);
    this._client._onsend = message => {
      if (this._client.readyState !== WebSocketMock.OPEN)
        throw new DOMException(`WebSocket is already in CLOSING or CLOSED state.`);
      messageToData(message, data => this._sendEval({ type: 'clientSend', id: this._id, data }));
    };
    this._client._onclose = (code, reason, wasClean) => {
      this._sendEval({ type: 'clientClose', id: this._id, code, reason, wasClean });
    };
    this._client.readyState = WebSocketMock.OPEN;
    this.client = this._client;

    this._server = new WebSocketMock(url);
    this._server._onsend = message => {
      if (this._server.readyState === WebSocketMock.CONNECTING)
        throw new Error('Cannot send a message before connecting to the server');
      if (this._server.readyState !== WebSocketMock.OPEN)
        throw new DOMException(`WebSocket is already in CLOSING or CLOSED state.`);
      messageToData(message, data => this._sendEval({ type: 'serverSend', id: this._id, data }));
    };
    this._server._onclose = (code, reason, wasClean) => {
      this._sendEval({ type: 'serverClose', id: this._id, code, reason, wasClean });
    };
    this.server = this._server as any;
    this.server.connect = () => {
      if (this._server.readyState !== WebSocketMock.CONNECTING)
        throw new Error('Can only connect to the server once');
      // Pretend to be open right away to simplify tests.
      this._server.readyState = WebSocketMock.OPEN;
      dispatchEvent(new Event('open'), this._server);
      this._sendEval({ type: 'serverConnect', id: this._id });
    };
  }

  _frameNavigatedAway() {
    this._onWSClose(undefined, undefined, true);
    this._onCleanup();
  }

  _onCleanup() {
    idToRoute.delete(this._id);
    const list = (this._frame as any)[routesSymbol] || [];
    (this._frame as any)[routesSymbol] = list.filter((route: WebSocketRouteImpl) => route !== this);
  }

  _onSend(message: WebSocketMessage) {
    const event = new MessageEvent('message', { data: message, origin: this._client._origin });
    dispatchEvent(event, this._client);
    if (!event.defaultPrevented && this._server.readyState === WebSocketMock.OPEN)
      this._server.send(message);
  }

  _onClose(code: number | undefined, reason: string | undefined, wasClean: boolean) {
    this._server._onclose?.(code, reason, wasClean);
  }

  _onWSMessage(message: WebSocketMessage) {
    const event = new MessageEvent('message', { data: message, origin: this._server._origin });
    dispatchEvent(event, this._server);
    if (!event.defaultPrevented)
      this._client.send(event.data);
  }

  _onWSClose(code: number | undefined, reason: string | undefined, wasClean: boolean) {
    this._dispatchServerClose(code, reason, wasClean);
    this._dispatchClientClose(code, reason, wasClean);
    this._client._onclose?.(code, reason, wasClean);
  }

  _onWSError() {
    // Note: we deliberately do not dispatch "error" events in Node to avoid unhandled errors.
    this._sendEval({ type: 'clientError', id: this._id });
  }

  _sendEnsureOpened() {
    this._sendEval({ type: 'ensureOpened', id: this._id });
  }

  private _dispatchClientClose(code: number | undefined, reason: string | undefined, wasClean: boolean) {
    if (this._client.readyState === WebSocketMock.CLOSED)
      return;
    this._client.readyState = WebSocketMock.CLOSED;
    dispatchEvent(new CloseEvent('close', { code, reason, wasClean }), this._client);
  }

  private _dispatchServerClose(code: number | undefined, reason: string | undefined, wasClean: boolean) {
    if (this._server.readyState === WebSocketMock.CLOSED)
      return;
    this._server.readyState = WebSocketMock.CLOSED;
    dispatchEvent(new CloseEvent('close', { code, reason, wasClean }), this._server);
  }

  private _sendEval(request: EvalRequest) {
    this._frame.evaluate(r => (globalThis as any).__pwWebSocketDispatch(r), request).catch(() => {});
  }
}

function dispatchEvent(event: Event, target: WebSocketMock) {
  event.target = target;
  event.currentTarget = target;
  target.dispatchEvent(event as any);
}

class Event {
  readonly bubbles = true;
  readonly cancelable = false;
  readonly composed = true;
  currentTarget: any;
  defaultPrevented = false;
  readonly eventPhase = 2;
  readonly isTrusted = true;
  target: any;
  timeStamp: number;
  type: string;

  constructor(type: string, options: any = {}) {
    this.timeStamp = Date.now();
    this.type = type;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
  }

  stopImmediatePropagation() {
  }

  composedPath() {
    return [this.target];
  }
}

class CloseEvent extends Event {
  code: number | undefined;
  reason: string | undefined;
  wasClean: boolean;

  constructor(type: string, options: any) {
    super(type, options);
    this.code = options.code;
    this.reason = options.reason;
    this.wasClean = options.wasClean;
  }
}

class MessageEvent extends Event {
  readonly data: WebSocketMessage;
  readonly origin: string;
  readonly lastEventId = '';
  readonly source: any;
  readonly ports: any[] = [];

  constructor(type: string, options: any) {
    super(type, options);
    this.data = options.data;
    this.origin = options.origin;
  }
}
