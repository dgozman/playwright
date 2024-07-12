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

    // Each init script has a unique scriptId and will initialize across many contexts.
    const scriptId = payload.scriptId;
    // Assign a unique contextId to each execution context.
    let contextId = (context as any)[kContextIdSymbol];
    if (!contextId) {
      contextId = createGuid();
      (context as any)[kContextIdSymbol] = contextId;
    }
    // Inside each execution context, each init script can create a channel multiple times.
    // Channel has a sequential id. We differentiate channels from the same
    // init script by uniqueId = contextId:channelId.
    const uniqueId = contextId + ':' + payload.channelId;
    // Inside each execution context, channel is identified by its owner scriptId and channelId.
    // This compound dispatchId allows for a single map instead of nested maps.
    const dispatchId = scriptId + ':' + payload.channelId;

    let initScript = page.initScripts.get(scriptId);
    if (!initScript)
      initScript = page._browserContext.initScripts.get(scriptId);
    if (!initScript || !initScript._channelCallback)
      return;

    if ('connect' in payload) {
      const channel: InitScriptChannel = {
        frame: context.frame,
        scriptId,
        oncall: undefined,
        ondisconnect: undefined,
        call: async (method, args) => {
          const result = await context.evaluate(performCall, { bindingName: PLAYWRIGHT_BINDING_NAME, dispatchId, method, args });
          if ('error' in result)
            throw result.error;
          if ('message' in result && 'stack' in result) {
            const error = new Error(result.message);
            error.stack = result.stack;
            throw error;
          }
          return result.result;
        },
      };
      initScript._channels.set(uniqueId, channel);

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
        context.evaluate(deliverConnect, { bindingName: PLAYWRIGHT_BINDING_NAME, dispatchId }).catch(e => debugLogger.log('error', e));
      } catch (error) {
        initScript._channels.delete(uniqueId);
        if (isError(error))
          context.evaluate(deliverConnectError, { bindingName: PLAYWRIGHT_BINDING_NAME, dispatchId, message: error.message, stack: error.stack }).catch(e => debugLogger.log('error', e));
        else
          context.evaluate(deliverConnectErrorValue, { bindingName: PLAYWRIGHT_BINDING_NAME, dispatchId, error }).catch(e => debugLogger.log('error', e));
      }
      return;
    }

    const channel = initScript._channels.get(uniqueId);
    if (channel?.oncall) {
      const callId = payload.callId;
      try {
        const args = payload.args.map(a => parseEvaluationResultValue(a));
        const result = await channel.oncall(payload.method, args, callId);
        context.evaluate(deliverCallResult, { bindingName: PLAYWRIGHT_BINDING_NAME, dispatchId, callId, result }).catch(e => debugLogger.log('error', e));
      } catch (error) {
        if (isError(error))
          context.evaluate(deliverCallError, { bindingName: PLAYWRIGHT_BINDING_NAME, dispatchId, callId, message: error.message, stack: error.stack }).catch(e => debugLogger.log('error', e));
        else
          context.evaluate(deliverCallErrorValue, { bindingName: PLAYWRIGHT_BINDING_NAME, dispatchId, callId, error }).catch(e => debugLogger.log('error', e));
      }
    }

    function deliverConnect(arg: { bindingName: string, dispatchId: string }) {
      const payload: BindingEvalPayload = { connected: true };
      (globalThis as any)[arg.bindingName].__dispatch.get(arg.dispatchId)(payload);
    }

    function deliverConnectError(arg: { bindingName: string, dispatchId: string, message: string, stack: string | undefined }) {
      const error = new Error(arg.message);
      error.stack = arg.stack;
      const payload: BindingEvalPayload = { connected: true, error };
      (globalThis as any)[arg.bindingName].__dispatch.get(arg.dispatchId)(payload);
    }

    function deliverConnectErrorValue(arg: { bindingName: string, dispatchId: string, error: any }) {
      const payload: BindingEvalPayload = { connected: true, error: arg.error };
      (globalThis as any)[arg.bindingName].__dispatch.get(arg.dispatchId)(payload);
    }

    function deliverCallResult(arg: { bindingName: string, dispatchId: string, callId: number, result: any }) {
      const payload: BindingEvalPayload = { callId: arg.callId, result: arg.result };
      (globalThis as any)[arg.bindingName].__dispatch.get(arg.dispatchId)(payload);
    }

    function deliverCallError(arg: { bindingName: string, dispatchId: string, callId: number, message: string, stack: string | undefined }) {
      const error = new Error(arg.message);
      error.stack = arg.stack;
      const payload: BindingEvalPayload = { callId: arg.callId, error };
      (globalThis as any)[arg.bindingName].__dispatch.get(arg.dispatchId)(payload);
    }

    function deliverCallErrorValue(arg: { bindingName: string, dispatchId: string, callId: number, error: any }) {
      const payload: BindingEvalPayload = { callId: arg.callId, error: arg.error };
      (globalThis as any)[arg.bindingName].__dispatch.get(arg.dispatchId)(payload);
    }

    async function performCall(arg: { bindingName: string, dispatchId: string, method: string, args: any[] }) {
      const payload: BindingEvalPayload = { method: arg.method, args: arg.args };
      try {
        const result = await (globalThis as any)[arg.bindingName].__dispatch.get(arg.dispatchId)(payload);
        return { result };
      } catch (error) {
        if (error instanceof Error)
          return { message: error.message, stack: error.stack };
        return { error };
      }
    }
  }
}

const kContextIdSymbol = Symbol('contextId');

type BindingPayload = {
  scriptId: string;
  channelId: number;
  connect: true;
} | {
  scriptId: string;
  channelId: number;
  method: string;
  callId: number;
  args: SerializedValue[];
};
type BindingEvalPayload = {
  connected: true;
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
  let lastChannelId = 0;

  const connect = async (exposedObject: object) => {
    const channelId = ++lastChannelId;
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

    binding.__dispatch = binding.__dispatch || new Map();
    const dispatchId = scriptId + ':' + channelId;
    binding.__dispatch.set(dispatchId, async (payload: BindingEvalPayload) => {
      if ('connected' in payload) {
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

      if (typeof (exposedObject as any)[payload.method] !== 'function')
        throw new Error(`Method "${payload.method}" is not exposed from the page`);
      return (exposedObject as any)[payload.method](...payload.args);
    });

    const payload: BindingPayload = { scriptId, channelId, connect: true };
    binding(JSON.stringify(payload));
    await connectedPromise;
    return proxyObject;
  };

  connectCallback(connect);
}
