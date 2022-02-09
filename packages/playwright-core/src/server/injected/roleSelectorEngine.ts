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

import { SelectorEngine, SelectorRoot } from './selectorEngine';
import { parseComponentSelector } from './componentUtils';
import { computeAccessibleName } from '../../third_party/dom-accessibility-api/accessible-name';
import { isInaccessible, isSubtreeInaccessible } from '../../third_party/dom-accessibility-api/is-inaccessible';
import { getAriaBoolean, getAriaRole, getElementAccessibleName, isElementHiddenForRole } from './roleUtils';

const kAttributeGetters = {
  selected: (element: Element) => {
    // https://www.w3.org/TR/html-aam-1.0/#html-attribute-state-and-property-mappings
    if (element.tagName === 'OPTION')
      return (element as HTMLOptionElement).selected;
    return getAriaBoolean(element.getAttribute('aria-selected'));
  },

  checked: (element: Element) => {
    // https://www.w3.org/TR/html-aam-1.0/#html-attribute-state-and-property-mappings
    if ((element as HTMLInputElement).indeterminate !== undefined && (element as HTMLInputElement).indeterminate)
      return undefined;
    if ((element as HTMLInputElement).checked !== undefined)
      return (element as HTMLInputElement).checked;
    return getAriaBoolean(element.getAttribute('aria-checked'));
  },

  pressed: (element: Element) => {
    return getAriaBoolean(element.getAttribute('aria-pressed'));
  },

  expanded: (element: Element) => {
    return getAriaBoolean(element.getAttribute('aria-expanded'));
  },

  level: (element: Element) => {
    const value = element.getAttribute('aria-level');
    if (value !== null)
      return Number(value);
    return { 'H1': 1, 'H2': 2, 'H3': 3, 'H4': 4, 'H5': 5, 'H6': 6 }[element.tagName];
  },
}

export const RoleEngine: SelectorEngine = {
  queryAll(scope: SelectorRoot, selector: string): Element[] {
    const parsed = parseComponentSelector(selector);
    const role = parsed.name.toLowerCase();
    const attrs = parsed.attributes.map(attr => {
      const name = attr.jsonPath[0].toLowerCase() as 'selected' | 'checked' | 'pressed' | 'expanded' | 'level' | 'name' | 'hidden';
      if (attr.jsonPath.length > 1 || !['selected', 'checked', 'pressed', 'expanded', 'level', 'name', 'hidden'].includes(name))
        throw new Error(`Unknown attribute "${attr.jsonPath.join('.')}"`);
      if (name === 'level' && typeof attr.value !== 'number')
        throw new Error(`"level" must be a number`);
      if (name !== 'level' && typeof attr.value !== 'boolean')
        throw new Error(`"${name}" must be a boolean`);
      if (attr.op !== '<truthy>' && attr.op !== '=')
        throw new Error(`Unsupported attribute matcher "${attr.op}"`);
      return { name, value: attr.value };
    });

    const hiddenCache = new Map<Element, boolean>();
    const result: Element[] = [];
    const match = (element: Element) => {
      if (getAriaRole(element) !== role)
        return;
      let includeHidden = false;
      let accessibleName: string | undefined;
      for (const { name, value } of attrs) {
        if (name === 'hidden') {
          includeHidden = value;
          continue;
        }
        if (name === 'name') {
          accessibleName = value;
          continue;
        }
        const actual = kAttributeGetters[name](element);
        if (value !== actual)
          return;
      }
      if (!includeHidden) {
        const isHidden = isElementHiddenForRole(element, hiddenCache);
        if (isHidden)
          return;
      }
      if (accessibleName !== undefined) {
        const actualName = getElementAccessibleName(element, includeHidden, hiddenCache);
        if (actualName !== accessibleName)
          return;
      }
      result.push(element);
    };

    const query = (root: Element | ShadowRoot | Document) => {
      const shadows: ShadowRoot[] = [];
      if ((root as Element).shadowRoot)
        shadows.push((root as Element).shadowRoot!);
      for (const element of root.querySelectorAll('*')) {
        match(element);
        if (element.shadowRoot)
          shadows.push(element.shadowRoot);
      }
      shadows.forEach(query);
    };

    query(scope);
    return result;
  }
};
