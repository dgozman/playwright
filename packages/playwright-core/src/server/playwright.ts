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

import { Android } from './android/android';
import { AdbBackend } from './android/backendAdb';
import { PlaywrightOptions } from './browser';
import { Chromium } from './chromium/chromium';
import { Electron } from './electron/electron';
import { Firefox } from './firefox/firefox';
import { Selectors } from './selectors';
import { WebKit } from './webkit/webkit';
import { CallMetadata, createInstrumentation, SdkObject } from './instrumentation';
import { Debugger } from './supplements/debugger';
import { debugMode } from '../utils/utils';
import { RecorderSupplement } from './supplements/recorderSupplement';
import { commandsThatOpenDebugger } from '../protocol/channels';

export class Playwright extends SdkObject {
  readonly selectors: Selectors;
  readonly chromium: Chromium;
  readonly android: Android;
  readonly electron: Electron;
  readonly firefox: Firefox;
  readonly webkit: WebKit;
  readonly options: PlaywrightOptions;
  readonly playwrightDebugger: Debugger;

  constructor(sdkLanguage: string, isInternal: boolean) {
    super({ attribution: { isInternal }, instrumentation: createInstrumentation() } as any, undefined, 'Playwright');
    this.options = {
      rootSdkObject: this,
      selectors: new Selectors(),
      sdkLanguage: sdkLanguage,
    };
    this.chromium = new Chromium(this.options);
    this.firefox = new Firefox(this.options);
    this.webkit = new WebKit(this.options);
    this.electron = new Electron(this.options);
    this.android = new Android(new AdbBackend(), this.options);
    this.selectors = this.options.selectors;

    // Debugger will pause execution upon page.pause in headed mode.
    this.playwrightDebugger = new Debugger();
    this.instrumentation.addListener(this.playwrightDebugger);

    this.instrumentation.addListener({
      onBeforeCall: async (sdkObject: SdkObject, metadata: CallMetadata) => {
        const isDebugMode = debugMode() === 'inspector' || process.env.PWTEST_PWDEBUG;
        const command = metadata.type + '.' + metadata.method;
        if (commandsThatOpenDebugger.has(command) && isDebugMode && !isInternal)
          await RecorderSupplement.show(this, { pauseOnNextStatement: true });
      },
    });

    // When paused, show inspector.
    if (this.playwrightDebugger.isPaused())
      RecorderSupplement.show(this);
    this.playwrightDebugger.on(Debugger.Events.PausedStateChanged, () => {
      RecorderSupplement.show(this);
    });
  }
}

export function createPlaywright(sdkLanguage: string, isInternal: boolean = false) {
  return new Playwright(sdkLanguage, isInternal);
}
