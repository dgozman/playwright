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

import { escapeWithQuotes } from '../../../utils/stringUtils';
import type InjectedScript from '../../injected/injectedScript';
import { generateSelector } from '../../injected/selectorGenerator';

function createLocator(injectedScript: InjectedScript, initial: string) {
  class Locator {
    selector: string;
    element: Element | undefined;
    elements: Element[];

    constructor(selector: string) {
      this.selector = selector;
      const parsed = injectedScript.parseSelector(this.selector);
      this.element = injectedScript.querySelector(parsed, document, false);
      this.elements = injectedScript.querySelectorAll(parsed, document);
    }

    locator(selector: string): Locator {
      return new Locator(this.selector ? this.selector + ' >> ' + selector : selector);
    }

    withText(text: string | RegExp): Locator {
      const matcher = text instanceof RegExp ? 'text-matches' : 'has-text';
      const source = escapeWithQuotes(text instanceof RegExp ? text.source : text, '"');
      return new Locator(this.selector + ` >> :scope:${matcher}(${source})`);
    }
  }
  return new Locator(initial);
}

type ConsoleAPIInterface = {
  $: (selector: string) => void;
  $$: (selector: string) => void;
  locator: (selector: string) => any;
  inspect: (selector: string) => void;
  selector: (element: Element) => void;
  resume: () => void;
};

declare global {
  interface Window {
    playwright?: ConsoleAPIInterface;
    inspect: (element: Element | undefined) => void;
    _playwrightResume: () => Promise<void>;
  }
}

export class ConsoleAPI {
  private _injectedScript: InjectedScript;

  constructor(injectedScript: InjectedScript) {
    this._injectedScript = injectedScript;
    if (window.playwright)
      return;
    window.playwright = {
      $: (selector: string, strict?: boolean) => this._querySelector(selector, !!strict),
      $$: (selector: string) => this._querySelectorAll(selector),
      locator: (selector: string) => createLocator(this._injectedScript, selector),
      inspect: (selector: string) => this._inspect(selector),
      selector: (element: Element) => this._selector(element),
      resume: () => this._resume(),
    };
  }

  private _querySelector(selector: string, strict: boolean): (Element | undefined) {
    if (typeof selector !== 'string')
      throw new Error(`Usage: playwright.query('Playwright >> selector').`);
    const parsed = this._injectedScript.parseSelector(selector);
    return this._injectedScript.querySelector(parsed, document, strict);
  }

  private _querySelectorAll(selector: string): Element[] {
    if (typeof selector !== 'string')
      throw new Error(`Usage: playwright.$$('Playwright >> selector').`);
    const parsed = this._injectedScript.parseSelector(selector);
    return this._injectedScript.querySelectorAll(parsed, document);
  }

  private _inspect(selector: string) {
    if (typeof selector !== 'string')
      throw new Error(`Usage: playwright.inspect('Playwright >> selector').`);
    window.inspect(this._querySelector(selector, false));
  }

  private _selector(element: Element) {
    if (!(element instanceof Element))
      throw new Error(`Usage: playwright.selector(element).`);
    return generateSelector(this._injectedScript, element).selector;
  }

  private _resume() {
    window._playwrightResume().catch(() => {});
  }
}

export default ConsoleAPI;