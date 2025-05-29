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

import { evaluationScript } from './clientHelper';
import { setTestIdAttribute } from './locator';

import type { SelectorEngine } from './types';
import type * as api from '../../types/types';
import type * as channels from '@protocol/channels';
import type { Platform } from './platform';

export class Selectors implements api.Selectors {
  private _platform: Platform;
  private _selectorEngines: channels.SelectorEngine[] = [];
  private _testIdAttributeName: string | undefined;

  constructor(platform: Platform) {
    this._platform = platform;
  }

  async register(name: string, script: string | (() => SelectorEngine) | { path?: string, content?: string }, options: { contentScript?: boolean } = {}): Promise<void> {
    if (this._selectorEngines.find(engine => engine.name === name))
      throw new Error(`"${name}" selector engine has been already registered`);
    const source = await evaluationScript(this._platform, script, undefined, false);
    this._selectorEngines.push({ ...options, name, source });
  }

  setTestIdAttribute(attributeName: string) {
    this._testIdAttributeName = attributeName;
    setTestIdAttribute(attributeName);
  }

  _withSelectorOptions<T>(options: T) {
    return { ...options, selectorEngines: this._selectorEngines, testIdAttributeName: this._testIdAttributeName };
  }
}
