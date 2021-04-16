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

import { BrowserContext } from '../browserContext';
import { RecorderSupplement } from './recorderSupplement';
import { debugLogger } from '../../utils/debugLogger';
import { CallMetadata, InstrumentationListener, SdkObject } from '../instrumentation';
import { debugMode, isUnderTest } from '../../utils/utils';
import * as consoleApiSource from '../../generated/consoleApiSource';

export class InspectorController implements InstrumentationListener {
  private _waitOperations = new Map<string, CallMetadata>();

  async onContextCreated(context: BrowserContext): Promise<void> {
    if (debugMode() === 'inspector')
      await RecorderSupplement.getOrCreate(context, { pauseOnNextStatement: true });
    else if (debugMode() === 'console')
      await context.extendInjectedScript(consoleApiSource.source);
  }

  async onBeforeCall(sdkObject: SdkObject, metadata: CallMetadata): Promise<void> {
    const context = sdkObject.attribution.context;
    if (!context)
      return;

    // Process logs for waitForNavigation/waitForLoadState
    if (metadata.params?.info?.waitId) {
      const info = metadata.params.info;
      switch (info.phase) {
        case 'before':
          metadata.method = info.name;
          metadata.stack = info.stack;
          this._waitOperations.set(info.waitId, metadata);
          break;
        case 'log':
          const originalMetadata = this._waitOperations.get(info.waitId)!;
          originalMetadata.log.push(info.message);
          this.onCallLog('api', info.message, sdkObject, originalMetadata);
          // Fall through.
        case 'after':
          return;
      }
    }

    if (shouldOpenInspector(sdkObject, metadata))
      await RecorderSupplement.getOrCreate(context, { pauseOnNextStatement: true });

    const recorder = await RecorderSupplement.getNoCreate(context);
    await recorder?.onBeforeCall(sdkObject, metadata);
  }

  async onAfterCall(sdkObject: SdkObject, metadata: CallMetadata): Promise<void> {
    if (!sdkObject.attribution.context)
      return;

    // Process logs for waitForNavigation/waitForLoadState
    if (metadata.params?.info?.waitId) {
      const info = metadata.params.info;
      switch (info.phase) {
        case 'before':
          metadata.endTime = 0;
          // Fall through.
        case 'log':
          return;
        case 'after':
          const originalMetadata = this._waitOperations.get(info.waitId)!;
          originalMetadata.endTime = metadata.endTime;
          originalMetadata.error = info.error;
          this._waitOperations.delete(info.waitId);
          metadata = originalMetadata;
          break;
      }
    }

    const recorder = await RecorderSupplement.getNoCreate(sdkObject.attribution.context);
    await recorder?.onAfterCall(sdkObject, metadata);
  }

  async onBeforeInputAction(sdkObject: SdkObject, metadata: CallMetadata): Promise<void> {
    if (!sdkObject.attribution.context)
      return;
    const recorder = await RecorderSupplement.getNoCreate(sdkObject.attribution.context);
    await recorder?.onBeforeInputAction(sdkObject, metadata);
  }

  async onCallLog(logName: string, message: string, sdkObject: SdkObject, metadata: CallMetadata): Promise<void> {
    debugLogger.log(logName as any, message);
    if (!sdkObject.attribution.context)
      return;
    const recorder = await RecorderSupplement.getNoCreate(sdkObject.attribution.context);
    recorder?.updateCallLog([metadata]);
  }
}

function shouldOpenInspector(sdkObject: SdkObject, metadata: CallMetadata): boolean {
  if (!sdkObject.attribution.browser?.options.headful && !isUnderTest())
    return false;
  return metadata.method === 'pause';
}
