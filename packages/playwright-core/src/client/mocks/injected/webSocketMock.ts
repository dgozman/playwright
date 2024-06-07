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

export type WebSocketMessage = string | ArrayBufferLike | Blob | ArrayBufferView;
export type WSData = { data: string, isBase64: boolean };

export class WebSocketMock {
  static readonly CONNECTING: 0 = 0; // WebSocket.CONNECTING
  static readonly OPEN: 1 = 1; // WebSocket.OPEN
  static readonly CLOSING: 2 = 2; // WebSocket.CLOSING
  static readonly CLOSED: 3 = 3; // WebSocket.CLOSED

  CONNECTING: 0 = 0; // WebSocket.CONNECTING
  OPEN: 1 = 1; // WebSocket.OPEN
  CLOSING: 2 = 2; // WebSocket.CLOSING
  CLOSED: 3 = 3; // WebSocket.CLOSED

  onclose: WebSocket['onclose'] = null;
  onerror: WebSocket['onerror'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onopen: WebSocket['onopen'] = null;

  binaryType: BinaryType = 'blob';
  bufferedAmount: number = 0;
  extensions: string = '';
  protocol: string = '';
  readyState: number = 0;
  readonly url: string;

  _origin: string = '';
  private _listeners = new Map<any, any[]>();
  _onsend?: (message: WebSocketMessage) => any;
  _onclose?: (code: number | undefined, reason: string | undefined, wasClean: boolean) => any;

  constructor(url: string) {
    this.url = url;
    try {
      this._origin = new URL(url).origin;
    } catch {
    }
  }

  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (this: WebSocket, ev: WebSocketEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    if (!this._listeners.has(type))
      this._listeners.set(type, []);
    this._listeners.get(type)!.push(listener);
  }

  removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (this: WebSocket, ev: WebSocketEventMap[K]) => any, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    if (!this._listeners.has(type))
      return;
    const stack = this._listeners.get(type)!;
    const index = stack.indexOf(callback);
    if (index !== -1)
      stack.splice(index, 1);
  }

  dispatchEvent(event: Event): boolean {
    let listeners = this._listeners.get(event.type) || [];
    if (event.type === 'error' && this.onerror)
      listeners = [this.onerror, ...listeners];
    if (event.type === 'close' && this.onclose)
      listeners = [this.onclose, ...listeners];
    if (event.type === 'message' && this.onmessage)
      listeners = [this.onmessage, ...listeners];
    if (event.type === 'open' && this.onopen)
      listeners = [this.onopen, ...listeners];
    for (const listener of listeners)
      listener.call(this, event);
    return !event.defaultPrevented;
  }

  send(message: WebSocketMessage): void {
    this._onsend?.(message);
  }

  close(code?: number, reason?: string): void {
    this._onclose?.(code, reason, true);
  }
}

function bufferToData(b: Uint8Array): WSData {
  let s = '';
  for (let i = 0; i < b.length; i++)
    s += String.fromCharCode(b[i]);
  return { data: globalThis.btoa(s), isBase64: true };
}

function stringToBuffer(s: string): ArrayBuffer {
  s = globalThis.atob(s);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++)
    b[i] = s.charCodeAt(i);
  return b.buffer;
}

// Note: this function tries to be synchronous when it can to preserve the ability to send
// multiple messages synchronously in the same order and then synchronously close.
export function messageToData(message: WebSocketMessage, cb: (data: WSData) => any) {
  if (message instanceof globalThis.Blob)
    return message.arrayBuffer().then(buffer => cb(bufferToData(new Uint8Array(buffer))));
  if (typeof message === 'string')
    return cb({ data: message, isBase64: false });
  if (ArrayBuffer.isView(message))
    return cb(bufferToData(new Uint8Array(message.buffer, message.byteOffset, message.byteLength)));
  return cb(bufferToData(new Uint8Array(message)));
}

export function dataToMessage(data: WSData, binaryType: 'blob' | 'arraybuffer'): WebSocketMessage {
  if (!data.isBase64)
    return data.data;
  const buffer = stringToBuffer(data.data);
  return binaryType === 'arraybuffer' ? buffer : new Blob([buffer]);
}
