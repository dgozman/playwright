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

import { type WebSocketMessage, type WSData, WebSocketMock, dataToMessage, messageToData } from './webSocketMock';

export type OnConnectRequest = { type: 'onConnect', id: string, url: string };
export type OnSendRequest = { type: 'onSend', id: string, data: WSData };
export type OnCloseRequest = { type: 'onClose', id: string, code: number | undefined, reason: string | undefined, wasClean: boolean };
export type OnCleanupRequest = { type: 'onCleanup', id: string };
export type OnWSMessageRequest = { type: 'onWSMessage', id: string, data: WSData };
export type OnWSCloseRequest = { type: 'onWSClose', id: string, code: number | undefined, reason: string | undefined, wasClean: boolean };
export type OnWSErrorRequest = { type: 'onWSError', id: string };
export type BindingRequest = OnConnectRequest | OnSendRequest | OnCloseRequest | OnCleanupRequest | OnWSMessageRequest | OnWSCloseRequest | OnWSErrorRequest;

export type EnsureOpenedRequest = { type: 'ensureOpened', id: string };
export type ClientSendRequest = { type: 'clientSend', id: string, data: WSData };
export type ClientCloseRequest = { type: 'clientClose', id: string, code: number | undefined, reason: string | undefined, wasClean: boolean };
export type ServerSendRequest = { type: 'serverSend', id: string, data: WSData };
export type ServerCloseRequest = { type: 'serverClose', id: string, code: number | undefined, reason: string | undefined, wasClean: boolean };
export type ServerConnectRequest = { type: 'serverConnect', id: string };
export type ClientErrorRequest = { type: 'clientError', id: string };
export type EvalRequest = EnsureOpenedRequest | ClientSendRequest | ClientCloseRequest | ServerSendRequest | ServerCloseRequest | ServerConnectRequest | ClientErrorRequest;

export function inject() {
  if ((globalThis as any).__pwWebSocketDispatch)
    return;

  const binding = (globalThis as any).__pwWebSocketBinding as (message: BindingRequest) => void;
  const NativeWebSocket: typeof WebSocket = globalThis.WebSocket;

  const idToWebSocket = new Map<string, WebSocketImpl>();

  class WebSocketImpl extends WebSocketMock {
    private _protocols?: string | string[];
    private _ws?: WebSocket;
    private _id: string;
    private _wsBufferedMessages: WebSocketMessage[] = [];

    constructor(url: string | URL, protocols?: string | string[]) {
      super(typeof url === 'string' ? url : url.href);
      this._protocols = protocols;

      this._onsend = message => {
        if (this.readyState === WebSocketMock.CONNECTING)
          throw new DOMException(`Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.`);
        if (this.readyState !== WebSocketMock.OPEN)
          throw new DOMException(`WebSocket is already in CLOSING or CLOSED state.`);
        messageToData(message, data => binding({ type: 'onSend', id: this._id, data }));
      };
      this._onclose = (code, reason) => {
        if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999))
          throw new DOMException(`Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. 1008 is neither.`);
        if (this.readyState === WebSocketMock.OPEN || this.readyState === WebSocketMock.CONNECTING)
          this.readyState = WebSocketMock.CLOSING;
        binding({ type: 'onClose', id: this._id, code, reason, wasClean: true });
      };

      this._id = generateId();
      idToWebSocket.set(this._id, this);
      binding({ type: 'onConnect', id: this._id, url: this.url });
    }

    _serverConnect() {
      if (this._ws)
        throw new Error('Cannot connect to the server when already connected');

      this._ws = new NativeWebSocket(this.url, this._protocols);
      this._ws.binaryType = this.binaryType;

      this._ws.onopen = event => {
        for (const message of this._wsBufferedMessages)
          this._ws!.send(message);
        this._wsBufferedMessages = [];
        this._ensureOpened();
      };

      this._ws.onclose = event => {
        this._onWSClose(event.code, event.reason, event.wasClean);
      };

      this._ws.onmessage = event => {
        this._onWSMessage(event.data);
      };

      this._ws.onerror = event => {
        this._onWSError();
      };
    }

    _serverSend(message: WebSocketMessage) {
      if (!this._ws)
        return;
      if (this._ws.readyState === WebSocketMock.CONNECTING)
        this._wsBufferedMessages.push(message);
      else if (this._ws.readyState === WebSocketMock.OPEN)
        this._ws.send(message);
    }

    _clientSend(message: WebSocketMessage) {
      this._ensureOpened();
      this.dispatchEvent(new MessageEvent('message', { data: message, origin: this._origin }));
    }

    _clientClose(code: number | undefined, reason: string | undefined, wasClean: boolean) {
      if (this.readyState !== WebSocketMock.CLOSED) {
        this.readyState = WebSocketMock.CLOSED;
        this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean }));
      }
      // "client.close" imitates server closing the connection.
      // We immediately close the real WS and imitate that it has closed.
      if (this._ws) {
        this._ws.close(code, reason);
        this._onWSClose(code, reason, wasClean);
      }
      // At this point, there will be no more events, so clean things up.
      binding({ type: 'onCleanup', id: this._id });
      idToWebSocket.delete(this._id);
    }

    _serverClose(code: number | undefined, reason: string | undefined, wasClean: boolean) {
      if (this._ws)
        this._ws.close(code, reason);
      else
        this._onWSClose(code, reason, wasClean);
    }

    _clientError() {
      this.dispatchEvent(new Event('error'));
    }

    _onWSClose(code: number | undefined, reason: string | undefined, wasClean: boolean) {
      this._cleanupWS();
      binding({ type: 'onWSClose', id: this._id, code, reason, wasClean });
    }

    _onWSError() {
      binding({ type: 'onWSError', id: this._id });
    }

    _onWSMessage(message: WebSocketMessage) {
      messageToData(message, data => binding({ type: 'onWSMessage', id: this._id, data }));
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

    _ensureOpened() {
      if (this.readyState !== WebSocketMock.CONNECTING)
        return;
      this.readyState = WebSocketMock.OPEN;
      this.dispatchEvent(new Event('open'));
    }
  }

  function generateId() {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    const hex = '0123456789abcdef';
    return [...bytes].map(value => {
      const high = Math.floor(value / 16);
      const low = value % 16;
      return hex[high] + hex[low];
    }).join('');
  }

  globalThis.WebSocket = class WebSocket extends WebSocketImpl {};
  (globalThis as any).__pwWebSocketDispatch = (request: EvalRequest) => {
    const ws = idToWebSocket.get(request.id);
    if (!ws)
      return;

    if (request.type === 'ensureOpened')
      ws._ensureOpened();
    if (request.type === 'clientSend')
      ws._clientSend(dataToMessage(request.data, ws.binaryType));
    if (request.type === 'clientClose')
      ws._clientClose(request.code, request.reason, request.wasClean);
    if (request.type === 'serverSend')
      ws._serverSend(dataToMessage(request.data, ws.binaryType));
    if (request.type === 'serverClose')
      ws._serverClose(request.code, request.reason, request.wasClean);
    if (request.type === 'serverConnect')
      ws._serverConnect();
    if (request.type === 'clientError')
      ws._clientError();
  };
}
