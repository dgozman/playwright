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

import { type AttributeSelectorPart } from '../isomorphic/selectorParser';
import { isElementVisible } from './domUtils';

export function matchesComponentAttribute(obj: any, attr: AttributeSelectorPart) {
  for (const token of attr.jsonPath) {
    if (obj !== undefined && obj !== null)
      obj = obj[token];
  }
  return matchesAttributePart(obj, attr);
}

export function matchesAttributePart(value: any, attr: AttributeSelectorPart) {
  const objValue = typeof value === 'string' && !attr.caseSensitive ? value.toUpperCase() : value;
  const attrValue = typeof attr.value === 'string' && !attr.caseSensitive ? attr.value.toUpperCase() : attr.value;

  if (attr.op === '<truthy>')
    return !!objValue;
  if (attr.op === '=') {
    if (attrValue instanceof RegExp)
      return typeof objValue === 'string' && !!objValue.match(attrValue);
    return objValue === attrValue;
  }
  if (typeof objValue !== 'string' || typeof attrValue !== 'string')
    return false;
  if (attr.op === '*=')
    return objValue.includes(attrValue);
  if (attr.op === '^=')
    return objValue.startsWith(attrValue);
  if (attr.op === '$=')
    return objValue.endsWith(attrValue);
  if (attr.op === '|=')
    return objValue === attrValue || objValue.startsWith(attrValue + '-');
  if (attr.op === '~=')
    return objValue.split(' ').includes(attrValue);
  return false;
}


export function createLaxTextMatcher(text: string): TextMatcher {
  text = text.trim().replace(/\s+/g, ' ').toLowerCase();
  return (elementText: ElementText) => {
    const s = elementText.full.trim().replace(/\s+/g, ' ').toLowerCase();
    return s.includes(text);
  };
}

export function createStrictTextMatcher(text: string): TextMatcher {
  text = text.trim().replace(/\s+/g, ' ');
  return (elementText: ElementText) => {
    if (!text && !elementText.immediate.length)
      return true;
    return elementText.immediate.some(s => s.trim().replace(/\s+/g, ' ') === text);
  };
}

export function createStrictFullTextMatcher(text: string): TextMatcher {
  text = text.trim().replace(/\s+/g, ' ');
  return (elementText: ElementText) => {
    return elementText.full.trim().replace(/\s+/g, ' ') === text;
  };
}

export function createRegexTextMatcher(source: string, flags?: string): TextMatcher {
  const re = new RegExp(source, flags);
  return (elementText: ElementText) => {
    return re.test(elementText.full);
  };
}

export function shouldSkipForTextMatching(element: Element | ShadowRoot, includeHidden: boolean) {
  return element.nodeName === 'SCRIPT'
      || element.nodeName === 'NOSCRIPT'
      || element.nodeName === 'STYLE'
      || document.head && document.head.contains(element)
      || !includeHidden && element.nodeType === 1 /* Node.ELEMENT_NODE */ && !isElementVisible(element as Element);
}

export type ElementText = { full: string, immediate: string[] };
export type TextMatcher = (text: ElementText) => boolean;

export function elementText(cache: Map<Element | ShadowRoot, ElementText>, root: Element | ShadowRoot, includeHidden: boolean): ElementText {
  let value = cache.get(root);
  if (value === undefined) {
    value = { full: '', immediate: [] };
    if (!shouldSkipForTextMatching(root, includeHidden)) {
      let currentImmediate = '';
      if ((root instanceof HTMLInputElement) && (root.type === 'submit' || root.type === 'button')) {
        value = { full: root.value, immediate: [root.value] };
      } else {
        for (let child = root.firstChild; child; child = child.nextSibling) {
          if (child.nodeType === Node.TEXT_NODE) {
            value.full += child.nodeValue || '';
            currentImmediate += child.nodeValue || '';
          } else {
            if (currentImmediate)
              value.immediate.push(currentImmediate);
            currentImmediate = '';
            if (child.nodeType === Node.ELEMENT_NODE)
              value.full += elementText(cache, child as Element, includeHidden).full;
          }
        }
        if (currentImmediate)
          value.immediate.push(currentImmediate);
        if ((root as Element).shadowRoot)
          value.full += elementText(cache, (root as Element).shadowRoot!, includeHidden).full;
      }
    }
    cache.set(root, value);
  }
  return value;
}

export function elementMatchesText(cache: Map<Element | ShadowRoot, ElementText>, element: Element, matcher: TextMatcher, includeHidden: boolean): 'none' | 'self' | 'selfAndChildren' {
  if (shouldSkipForTextMatching(element, includeHidden))
    return 'none';
  if (!matcher(elementText(cache, element, includeHidden)))
    return 'none';
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.ELEMENT_NODE && matcher(elementText(cache, child as Element, includeHidden)))
      return 'selfAndChildren';
  }
  if (element.shadowRoot && matcher(elementText(cache, element.shadowRoot, includeHidden)))
    return 'selfAndChildren';
  return 'self';
}
