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

import { parseEvaluationResultValue, source as utilityScriptSerializersSource } from './isomorphic/utilityScriptSerializers';
import type { SerializedValue } from './isomorphic/utilityScriptSerializers';
import type { Frame } from './frames';
import { Page } from './page';
import type { FrameExecutionContext } from './dom';
import { createGuid, isError } from '../utils';
import { debugLogger } from '../utils/debugLogger';

export const PLAYWRIGHT_BINDING_NAME = '__pw_binding';

export interface InitScriptChannel {
  readonly frame: Frame;
  readonly scriptId: string;
  oncall?: (method: string, args: any[], callId: number) => Promise<any>;
  ondisconnect?: () => void;
  call(method: string, args: any[]): Promise<any>;
}

export type InitScriptChannelCallback = (channel: InitScriptChannel) => Promise<void>;

export class InitScript {
  readonly scriptId: string;
  readonly source: string;
  private _channelCallback?: InitScriptChannelCallback;
  private _channels = new Map<string, InitScriptChannel>();

  constructor(source: string, channelCallback?: InitScriptChannelCallback) {
    this.scriptId = createGuid();
    this._channelCallback = channelCallback;
    if (channelCallback) {
      // "source" must be a function expression here.
      source = `(${connectScriptChannel.toString()})(
        ${JSON.stringify(PLAYWRIGHT_BINDING_NAME)},
        ${JSON.stringify(this.scriptId)},
        (${source}),
        (${utilityScriptSerializersSource})(),
      );`;
    }
    this.source = `(() => {
      globalThis.__pwInitScripts = globalThis.__pwInitScripts || {};
      const hasInitScript = globalThis.__pwInitScripts[${JSON.stringify(this.scriptId)}];
      if (hasInitScript)
        return;
      globalThis.__pwInitScripts[${JSON.stringify(this.scriptId)}] = true;
      ${source}
    })();`;
  }

  static async dispatchBinding(page: Page, payloadString: string, context: FrameExecutionContext) {
    const payload = JSON.parse(payloadString) as BindingPayload;
    const scriptId = payload.scriptId;

    let initScript = page.initScripts.get(scriptId);
    if (!initScript)
      initScript = page._browserContext.initScripts.get(scriptId);
    if (!initScript || !initScript._channelCallback)
      return;

    if ('connect' in payload) {
      const channelId = createGuid();
      const channel: InitScriptChannel = {
        frame: context.frame,
        scriptId,
        oncall: undefined,
        ondisconnect: undefined,
        call: async (method, args) => {
          return await context.evaluate(performCall, { bindingName: PLAYWRIGHT_BINDING_NAME, scriptId, method, args });
        },
      };
      initScript._channels.set(channelId, channel);

      // TODO: perhaps introduce ExecutionContextDestroyed event instead?
      let disconnected = false;
      const listener = (frame: Frame | undefined) => {
        if (disconnected)
          return;
        if (!frame || frame === context.frame) {
          disconnected = true;
          channel.ondisconnect?.();
        }
      };
      page.on(Page.Events.InternalFrameNavigatedToNewDocument, listener);
      page.on(Page.Events.FrameDetached, listener);
      page.on(Page.Events.Close, listener);
      page.on(Page.Events.Crash, listener);

      try {
        await initScript._channelCallback(channel);
        context.evaluate(deliverConnect, { bindingName: PLAYWRIGHT_BINDING_NAME, scriptId, channelId }).catch(e => debugLogger.log('error', e));
      } catch (error) {
        initScript._channels.delete(channelId);
        if (isError(error))
          context.evaluate(deliverConnectError, { bindingName: PLAYWRIGHT_BINDING_NAME, scriptId, channelId, message: error.message, stack: error.stack }).catch(e => debugLogger.log('error', e));
        else
          context.evaluate(deliverConnectErrorValue, { bindingName: PLAYWRIGHT_BINDING_NAME, scriptId, channelId, error }).catch(e => debugLogger.log('error', e));
      }
      return;
    }

    const channel = initScript._channels.get(payload.channelId);
    if (channel?.oncall) {
      const callId = payload.callId;
      try {
        const args = payload.args.map(a => parseEvaluationResultValue(a));
        const result = await channel.oncall(payload.method, args, callId);
        context.evaluate(deliverCallResult, { bindingName: PLAYWRIGHT_BINDING_NAME, scriptId, callId, result }).catch(e => debugLogger.log('error', e));
      } catch (error) {
        if (isError(error))
          context.evaluate(deliverCallError, { bindingName: PLAYWRIGHT_BINDING_NAME, scriptId, callId, message: error.message, stack: error.stack }).catch(e => debugLogger.log('error', e));
        else
          context.evaluate(deliverCallErrorValue, { bindingName: PLAYWRIGHT_BINDING_NAME, scriptId, callId, error }).catch(e => debugLogger.log('error', e));
      }
    }

    function deliverConnect(arg: { bindingName: string, scriptId: string, channelId: string }) {
      const payload: BindingEvalPayload = { channelId: arg.channelId };
      (globalThis as any)[arg.bindingName].__dispatchers.get(arg.scriptId)(payload);
    }

    function deliverConnectError(arg: { bindingName: string, scriptId: string, channelId: string, message: string, stack: string | undefined }) {
      const error = new Error(arg.message);
      error.stack = arg.stack;
      const payload: BindingEvalPayload = { channelId: arg.channelId, error };
      (globalThis as any)[arg.bindingName].__dispatchers.get(arg.scriptId)(payload);
    }

    function deliverConnectErrorValue(arg: { bindingName: string, scriptId: string, channelId: string, error: any }) {
      const payload: BindingEvalPayload = { channelId: arg.channelId, error: arg.error };
      (globalThis as any)[arg.bindingName].__dispatchers.get(arg.scriptId)(payload);
    }

    function deliverCallResult(arg: { bindingName: string, scriptId: string, callId: number, result: any }) {
      const payload: BindingEvalPayload = { callId: arg.callId, result: arg.result };
      (globalThis as any)[arg.bindingName].__dispatchers.get(arg.scriptId)(payload);
    }

    function deliverCallError(arg: { bindingName: string, scriptId: string, callId: number, message: string, stack: string | undefined }) {
      const error = new Error(arg.message);
      error.stack = arg.stack;
      const payload: BindingEvalPayload = { callId: arg.callId, error };
      (globalThis as any)[arg.bindingName].__dispatchers.get(arg.scriptId)(payload);
    }

    function deliverCallErrorValue(arg: { bindingName: string, scriptId: string, callId: number, error: any }) {
      const payload: BindingEvalPayload = { callId: arg.callId, error: arg.error };
      (globalThis as any)[arg.bindingName].__dispatchers.get(arg.scriptId)(payload);
    }

    async function performCall(arg: { bindingName: string, scriptId: string, method: string, args: any[] }) {
      const payload: BindingEvalPayload = { method: arg.method, args: arg.args };
      return await (globalThis as any)[arg.bindingName].__dispatchers.get(arg.scriptId)(payload);
    }
  }
}

type BindingPayload = {
  scriptId: string;
  connect: true;
} | {
  scriptId: string;
  channelId: string;
  method: string;
  callId: number;
  args: SerializedValue[];
};
type BindingEvalPayload = {
  channelId: string;
  error?: any;
} | {
  callId: number;
  error?: any;
  result?: any;
} | {
  method: string;
  args: any[];
};

function connectScriptChannel(bindingName: string, scriptId: string, connectCallback: (connect: (exposedObject: object) => Promise<object>) => any, utilityScriptSerializers: ReturnType<typeof utilityScriptSerializersSource>) {
  const binding = (globalThis as any)[bindingName];
  let channelId = '';

  let exposedObjectCallback = (o: object) => {};
  const exposedObjectPromise = new Promise<object>(resolve => exposedObjectCallback = resolve);

  let lastCallId = 0;
  const calls = new Map<number, { resolve: (value: any) => void, reject: (error: any) => void }>();

  const proxyObject = new Proxy({}, {
    get: (obj: any, prop: string | symbol) => {
      if (typeof prop !== 'string' || Reflect.has(obj, prop) || prop === 'then')
        return Reflect.get(obj, prop);
      return async (...args: any[]) => {
        const callId = ++lastCallId;
        const promise = new Promise<any>((resolve, reject) => calls.set(callId, { resolve, reject }));

        const serializedArgs = [];
        for (let i = 0; i < args.length; i++) {
          serializedArgs[i] = utilityScriptSerializers.serializeAsCallArgument(args[i], v => {
            return { fallThrough: v };
          });
        }

        const payload: BindingPayload = {
          scriptId,
          channelId,
          method: prop,
          callId,
          args: serializedArgs,
        };
        binding(JSON.stringify(payload));
        return promise;
      };
    },
  });

  let connectedResolve = () => {};
  let connectedReject = (error: any) => {};
  const connectedPromise = new Promise<void>((resolve, reject) => {
    connectedResolve = resolve;
    connectedReject = reject;
  });

  binding.__dispatchers = binding.__dispatchers || new Map();
  binding.__dispatchers.set(scriptId, async (payload: BindingEvalPayload) => {
    if ('channelId' in payload) {
      channelId = payload.channelId;
      if ('error' in payload)
        connectedReject(payload.error);
      else
        connectedResolve();
      return;
    }

    if ('callId' in payload) {
      const call = calls.get(payload.callId);
      calls.delete(payload.callId);
      if (call) {
        if ('error' in payload)
          call.reject(payload.error);
        else
          call.resolve(payload.result);
      }
      return;
    }

    const exposedObject = await exposedObjectPromise;
    if (typeof (exposedObject as any)[payload.method] !== 'function')
      throw new Error(`Method "${payload.method}" is not exposed from the page`);
    return (exposedObject as any)[payload.method](...payload.args);
  });

  const payload: BindingPayload = { scriptId, connect: true };
  binding(JSON.stringify(payload));

  connectCallback(async exposedObject => {
    exposedObjectCallback(exposedObject);
    await connectedPromise;
    return proxyObject;
  });
}
