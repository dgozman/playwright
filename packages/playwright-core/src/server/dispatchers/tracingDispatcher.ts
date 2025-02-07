/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License");
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

import { ArtifactDispatcher } from './artifactDispatcher';
import { Dispatcher, DispatcherScope, existingDispatcher } from './dispatcher';
import { Tracing } from '../trace/recorder/tracing';

import type { CallMetadata } from '@protocol/callMetadata';
import type * as channels from '@protocol/channels';

export class TracingDispatcher extends Dispatcher<Tracing, channels.TracingChannel, DispatcherScope> implements channels.TracingChannel {
  _type_Tracing = true;

  static from(scope: DispatcherScope, tracing: Tracing): TracingDispatcher {
    const result = existingDispatcher<TracingDispatcher>(tracing);
    return result || new TracingDispatcher(scope, tracing);
  }

  constructor(scope: DispatcherScope, tracing: Tracing) {
    super(scope, tracing, 'Tracing', {});
    // Tracing can outlive the owner context, so that trace can be recovered after the context is gone.
    // Therefore, tracing dispatcher is disposed when a) owner context is closed and b) any ongoing recording is stopped.
    this.addObjectListener(Tracing.Events.ReadyToDispose, () => this._dispose());
  }

  async tracingStart(params: channels.TracingTracingStartParams): Promise<channels.TracingTracingStartResult> {
    await this._object.start(params);
  }

  async tracingStartChunk(params: channels.TracingTracingStartChunkParams): Promise<channels.TracingTracingStartChunkResult> {
    return await this._object.startChunk(params);
  }

  async tracingGroup(params: channels.TracingTracingGroupParams, metadata: CallMetadata): Promise<channels.TracingTracingGroupResult> {
    const { name, location } = params;
    await this._object.group(name, location, metadata);
  }

  async tracingGroupEnd(params: channels.TracingTracingGroupEndParams): Promise<channels.TracingTracingGroupEndResult> {
    await this._object.groupEnd();
  }

  async tracingStopChunk(params: channels.TracingTracingStopChunkParams): Promise<channels.TracingTracingStopChunkResult> {
    const { artifact, entries } = await this._object.stopChunk(params);
    return { artifact: artifact ? ArtifactDispatcher.from(this, artifact) : undefined, entries };
  }

  async tracingStop(params: channels.TracingTracingStopParams): Promise<channels.TracingTracingStopResult> {
    await this._object.stop();
  }

}
