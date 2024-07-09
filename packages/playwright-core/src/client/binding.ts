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

import { EventEmitter } from 'events';
import { serializeError, parseError } from './errors';
import type * as structs from '../../types/structs';
import type * as channels from '@protocol/channels';
import { ChannelOwner } from './channelOwner';
import { ManualPromise } from '../utils';
import { Frame } from './frame';
import { parseResult, serializeArgument } from './jsHandle';
import type { Page } from './page';
import type { BrowserContext } from './browserContext';

export class BindingChannel extends ChannelOwner<channels.BindingChannelChannel> {
  static from(channel: channels.BindingChannelChannel): BindingChannel {
    return (channel as any)._object;
  }

  private _disconnected = false;
  private _source: structs.InitScriptSource;
  private _proxyObject: any;
  private _realObjectPromise = new ManualPromise<any>();

  constructor(parent: ChannelOwner, type: string, guid: string, initializer: channels.BindingChannelInitializer) {
    super(parent, type, guid, initializer);

    const source = (new EventEmitter()) as any;
    const frame = Frame.from(this._initializer.frame);
    source.frame = frame;
    source.page = frame._page!;
    source.context = frame._page!.context();

    this._source = source;
    this._proxyObject = new Proxy({}, {
      get: (obj: any, prop: string | symbol) => {
        if (typeof prop !== 'string' || Reflect.has(obj, prop))
          return Reflect.get(obj, prop);
        return async (...args: any[]) => {
          if (this._disconnected)
            throw new Error(`In-page channel had already disconnected`);
          const response = await this._channel.call({ method: prop, args: args.map(arg => serializeArgument(arg)) });
          if (response.error)
            throw parseError(response.error);
          return parseResult(response.result!);
        };
      },
    });

    this._channel.on('disconnected', () => {
      this._disconnected = true;
      this._source.emit('disconnected', this._source);
    });
    this._channel.on('call', async params => {
      const realObject = await this._realObjectPromise;
      if (this._disconnected)
        return;
      try {
        const result = await realObject[params.method](...params.args.map(arg => parseResult(arg)));
        this._channel.respond({ callId: params.callId, result: serializeArgument(result) }).catch(() => {});
      } catch (error) {
        this._channel.respond({ callId: params.callId, error: serializeError(error) }).catch(() => {});
      }
    });
  }

  connect(func: Function) {
    const promise = (async () => func(this._proxyObject, this._source))();
    promise.then(object => {
      this._realObjectPromise.resolve(object);
      this._channel.connected().catch(() => {});
    }, error => {
      this._channel.connected({ error: serializeError(error) }).catch(() => {});
    });
  }
}

export async function exposeBindingImpl(target: Page | BrowserContext, name: string, callback: (source: structs.BindingSource, ...args: any[]) => any, options: { handle?: boolean }) {
  if (options.handle) {
    await target.addInitScript(`connect => {
      const bindingPromise = connect({});
      let lastCallId = 0;
      const handles = new Map();
      window["${name}"] = async (...args) => bindingPromise.then(async binding => {
        const callId = ++lastCallId;
        handles.set(callId, args[0]);
        try {
          return await binding.invoke(callId);
        } finally {
          handles.delete(callId);
        }
      });
      window["${name}"].__handles = handles;
    }`, async (_: object, source: structs.InitScriptSource) => ({
      invoke: async (callId: number, ...args: any[]) => {
        const handle = await source.frame.evaluateHandle(`window["${name}"].__handles.get(${callId})`);
        try {
          return await callback(source, handle);
        } finally {
          handle?.dispose();
        }
      },
    }));
    return;
  }

  await target.addInitScript(`connect => {
    const bindingPromise = connect({});
    window["${name}"] = async (...args) => bindingPromise.then(binding => binding.invoke(...args));
  }`, async (_: object, source: structs.InitScriptSource) => ({
    invoke: async (...args: any[]) => callback(source, ...args),
  }));
}
