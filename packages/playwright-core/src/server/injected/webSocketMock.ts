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

import { urlMatches } from '../../utils/isomorphic/urlMatch';
import type { WebSocketRoute } from '../../../types/websocket';

type WebSocketMessage = string | ArrayBufferLike | Blob | ArrayBufferView;

class WebSocketMock extends EventTarget{
  static readonly CONNECTING: 0 = 0; // WebSocket.CONNECTING
  static readonly OPEN: 1 = 1; // WebSocket.OPEN
  static readonly CLOSING: 2 = 2; // WebSocket.CLOSING
  static readonly CLOSED: 3 = 3; // WebSocket.CLOSED

  CONNECTING: 0 = 0; // WebSocket.CONNECTING
  OPEN: 1 = 1; // WebSocket.OPEN
  CLOSING: 2 = 2; // WebSocket.CLOSING
  CLOSED: 3 = 3; // WebSocket.CLOSED

  private _oncloseListener: WebSocket['onclose'] = null;
  private _onerrorListener: WebSocket['onerror'] = null;
  private _onmessageListener: WebSocket['onmessage'] = null;
  private _onopenListener: WebSocket['onopen'] = null;

  bufferedAmount: number = 0;
  extensions: string = '';
  protocol: string = '';
  readyState: number = 0;
  readonly url: string;

  private _binaryType: BinaryType = 'blob';
  _origin: string = '';
  _onsend?: (message: WebSocketMessage) => any;
  _onclose?: (code: number | undefined, reason: string | undefined, wasClean: boolean) => any;
  _onbinaryType?: (type: BinaryType) => any;

  constructor(url: string) {
    super();
    this.url = url;
    try {
      this._origin = new URL(url).origin;
    } catch {
    }
  }

  get binaryType() {
    return this._binaryType;
  }

  set binaryType(type) {
    this._binaryType = type;
    this._onbinaryType?.(type);
  }

  get onclose() {
    return this._oncloseListener;
  }

  set onclose(listener) {
    if (this._oncloseListener)
      this.removeEventListener('close', this._oncloseListener as any);
    this._oncloseListener = listener;
    if (this._oncloseListener)
      this.addEventListener('close', this._oncloseListener as any);
  }

  get onerror() {
    return this._onerrorListener;
  }

  set onerror(listener) {
    if (this._onerrorListener)
      this.removeEventListener('error', this._onerrorListener);
    this._onerrorListener = listener;
    if (this._onerrorListener)
      this.addEventListener('error', this._onerrorListener);
  }

  get onopen() {
    return this._onopenListener;
  }

  set onopen(listener) {
    if (this._onopenListener)
      this.removeEventListener('open', this._onopenListener);
    this._onopenListener = listener;
    if (this._onopenListener)
      this.addEventListener('open', this._onopenListener);
  }

  get onmessage() {
    return this._onmessageListener;
  }

  set onmessage(listener) {
    if (this._onmessageListener)
      this.removeEventListener('message', this._onmessageListener as any);
    this._onmessageListener = listener;
    if (this._onmessageListener)
      this.addEventListener('message', this._onmessageListener as any);
  }

  send(message: WebSocketMessage): void {
    this._onsend?.(message);
  }

  close(code?: number, reason?: string): void {
    this._onclose?.(code, reason, true);
  }
}

function installMock(baseURL: string | undefined) {
  if ((globalThis as any).routeWebSocket)
    return;

  const NativeWebSocket: typeof WebSocket = globalThis.WebSocket;

  const registeredRoutes: { pattern: string | RegExp, handler: (route: WebSocketRoute) => any }[] = [];
  function registerRoute(pattern: string | RegExp, handler: (route: WebSocketRoute) => any) {
    registeredRoutes.push({ pattern, handler });
  }

  class WebSocketImpl extends WebSocketMock {
    private _protocols?: string | string[];
    private _ws?: WebSocket;
    private _wsBufferedMessages: WebSocketMessage[] = [];
    private _client: WebSocketMock;
    private _server: WebSocketMock;
    private _route: WebSocketRoute;

    constructor(url: string | URL, protocols?: string | string[]) {
      super(typeof url === 'string' ? url : url.href);
      this._protocols = protocols;

      this._client = new WebSocketMock(this.url);
      this._client.readyState = WebSocketMock.OPEN;
      this._client._onsend = message => {
        if (this._client.readyState !== WebSocketMock.OPEN)
          throw new DOMException(`WebSocket is already in CLOSING or CLOSED state.`);
        // Calling "client.send" from the route handler. Allow this for easier testing.
        this._ensureOpened();
        this.dispatchEvent(new MessageEvent('message', { data: message, origin: this._origin, cancelable: true }));
      };
      this._client._onclose = (code, reason, wasClean) => {
        if (this.readyState !== WebSocketMock.CLOSED) {
          this.readyState = WebSocketMock.CLOSED;
          this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean, cancelable: true }));
        }
        // "client.close" imitates server closing the connection.
        // We immediately close the real WS and imitate that it has closed.
        if (this._ws) {
          this._ws.close(code, reason);
          this._onWSClose(code, reason, wasClean);
        }
        // At this point, there will be no more events, so clean things up if needed.
      };

      this._server = new WebSocketMock(this.url);
      this._server._onsend = message => {
        if (this._server.readyState === WebSocketMock.CONNECTING)
          throw new Error('Cannot send a message before connecting to the server');
        if (this._server.readyState !== WebSocketMock.OPEN)
          throw new DOMException(`WebSocket is already in CLOSING or CLOSED state.`);
        if (!this._ws)
          return;
        if (this._ws.readyState === WebSocketMock.CONNECTING)
          this._wsBufferedMessages.push(message);
        else if (this._ws.readyState === WebSocketMock.OPEN)
          this._ws.send(message);
      };
      this._server._onclose = (code, reason, wasClean) => {
        if (this._ws)
          this._ws.close(code, reason);
        else
          this._onWSClose(code, reason, wasClean);
      };

      this._route = { client: this._client, server: this._server as any };
      this._route.server.connect = () => this._connect();

      this._onsend = message => {
        if (this.readyState === WebSocketMock.CONNECTING)
          throw new DOMException(`Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.`);
        if (this.readyState !== WebSocketMock.OPEN)
          throw new DOMException(`WebSocket is already in CLOSING or CLOSED state.`);

        const event = new MessageEvent('message', { data: message, origin: this._client._origin, cancelable: true });
        this._client.dispatchEvent(event);
        if (!event.defaultPrevented && this._ws)
          this._route.server.send(message);
      };
      this._onclose = (code, reason) => {
        if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999))
          throw new DOMException(`Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`);
        if (this.readyState === WebSocketMock.OPEN || this.readyState === WebSocketMock.CONNECTING)
          this.readyState = WebSocketMock.CLOSING;
        this._route.server.close(code, reason);
      };
      this._onbinaryType = type => {
        if (this._ws)
          this._ws.binaryType = type;
      };

      this._callHandler();
    }

    private async _callHandler() {
      for (const { pattern, handler } of registeredRoutes) {
        if (urlMatches(baseURL, this.url, pattern)) {
          await handler(this._route);
          if (!this._ws) {
            // If not connected to the server, automatically "open" in a separate task.
            // The test will mock the WebSocket without an actual server connection.
            setTimeout(() => this._ensureOpened());
          }
          return;
        }
      }
      this._route.server.connect();
    }

    private _connect() {
      if (this._server.readyState !== WebSocketMock.CONNECTING || this._ws)
        throw new Error('Can only connect to the server once');

      // Pretend to be open right away to simplify tests.
      this._server.readyState = WebSocketMock.OPEN;
      this._server.dispatchEvent(new Event('open', { cancelable: true }));

      this._ws = new NativeWebSocket(this.url, this._protocols);
      this._ws.binaryType = this.binaryType;

      this._ws.onopen = () => {
        for (const message of this._wsBufferedMessages)
          this._ws!.send(message);
        this._wsBufferedMessages = [];
        this._ensureOpened();
      };

      this._ws.onclose = event => {
        this._onWSClose(event.code, event.reason, event.wasClean);
      };

      this._ws.onmessage = event => {
        const serverEvent = new MessageEvent('message', { data: event.data, origin: this._server._origin, cancelable: true });
        this._server.dispatchEvent(serverEvent);
        if (!serverEvent.defaultPrevented)
          this._route.client.send(event.data);
      };

      this._ws.onerror = () => {
        // We do not expose errors in the API, so short-curcuit the error event.
        const event = new Event('error', { cancelable: true });
        this.dispatchEvent(event);
      };
    }

    private _onWSClose(code: number | undefined, reason: string | undefined, wasClean: boolean) {
      this._cleanupWS();
      if (this._server.readyState !== WebSocketMock.CLOSED) {
        this._server.readyState = WebSocketMock.CLOSED;
        this._server.dispatchEvent(new CloseEvent('close', { code, reason, wasClean, cancelable: true }));
      }
      if (this._client.readyState !== WebSocketMock.CLOSED) {
        this._client.readyState = WebSocketMock.CLOSED;
        this._client.dispatchEvent(new CloseEvent('close', { code, reason, wasClean, cancelable: true }));
      }
      this._client._onclose?.(code, reason, wasClean);
    }

    private _cleanupWS() {
      if (!this._ws)
        return;
      this._ws.onopen = null;
      this._ws.onclose = null;
      this._ws.onmessage = null;
      this._ws.onerror = null;
      this._ws = undefined;
      this._wsBufferedMessages = [];
    }

    private _ensureOpened() {
      if (this.readyState !== WebSocketMock.CONNECTING)
        return;
      this.readyState = WebSocketMock.OPEN;
      this.dispatchEvent(new Event('open', { cancelable: true }));
    }
  }

  globalThis.WebSocket = class WebSocket extends WebSocketImpl {};
  (globalThis as any).routeWebSocket = registerRoute;
}

export default function inject(baseURL: string | undefined) {
  installMock(baseURL);
}
