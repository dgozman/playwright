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

import { cssEscape, escapeForAttributeSelector, escapeForTextSelector, normalizeWhiteSpace } from '../../utils/isomorphic/stringUtils';
import { isInsideScope, parentElementOrShadowHost } from './domUtils';
import type { InjectedScript } from './injectedScript';
import { beginAriaCaches, endAriaCaches, getAriaRole, getElementAccessibleName, isElementHiddenForAria } from './roleUtils';
import { elementText, getElementLabels } from './selectorUtils';

export type GenerateSelectorOptions = {
  testIdAttributeName: string;
  retargetForAction?: boolean;
  retargetForText?: boolean;
  omitInternalEngines?: boolean;
  omitTextFrom?: Element;
  root?: Element | Document;
};

export function generateSelector(injectedScript: InjectedScript, targetElement: Element, options: GenerateSelectorOptions): { selector: string, elements: Element[] } {
  injectedScript._evaluator.begin();
  beginAriaCaches();
  try {
    const generator = new SelectorGenerator(injectedScript);
    return generator.generateSelector(targetElement, options);
  } finally {
    endAriaCaches();
    injectedScript._evaluator.end();
  }
}

type SelectorToken = {
  score: number;
  engine: 'role';
  role: string;
  accessibleName?: string;
  exact?: boolean;
} | {
  score: number;
  engine: 'css';
  css: () => string;
} | {
  score: number;
  engine: 'nth';
  index: number;
} | {
  score: number;
  engine: 'text';
  text: string;
  exact?: boolean;
} | {
  score: number;
  engine: 'testId';
  testId: string;
  exact?: boolean;
} | {
  score: number;
  engine: 'xpath';
  xpath: string;
} | {
  score: number;
  engine: 'attr';
  attr: string;
  value: string;
  exact?: boolean;
};

const kTestIdScore = 1;        // testIdAttributeName
const kOtherTestIdScore = 2;   // other data-test* attributes
const kIframeByAttributeScore = 10;
const kPlaceholderScore = 100;
const kLabelScore = 120;
const kRoleWithNameScore = 140;
const kAltTextScore = 160;
const kTextScore = 180;
const kTitleScore = 200;
const kCSSIdScore = 500;
const kRoleWithoutNameScore = 510;
const kCSSInputTypeNameScore = 520;

const kTextLengthMaxPenalty = 10;
const kExactPenalty = 5;

const kXPathParentsScore = 1000;
const kChainScorePenalty = 1;

const kNthScoreMin = 5000;
const kNthScoreMax = 10000;
const kCSSFallbackScore = 10000;

type AccessibleNameCacheEntry = {
  accessibleName: string;
  upperCase: string;
  textFrom?: Set<Element>;
}

let counters: Record<string, number> = {};

class SelectorGenerator {
  private _injected: InjectedScript;
  private _elementToCSSToken = new Map<Element, string>();
  private _elementToText = new Map<Element, { full: string, lowerCase: string }>();
  private _elementToChainWithText = new Map<Element, SelectorCandidateCollection>();
  private _elementToChainWithoutText = new Map<Element, SelectorCandidateCollection>();
  private _elementToRoleLists = new Map<Element | Document, Map<string, Element[]>>();
  private _elementToRole = new Map<Element, string | null>();
  private _elementToAccessibleName = new Map<Element, AccessibleNameCacheEntry>();
  private _roleToElements = new Map<string, Element[]>();
  private _textToElements = new Map<string, Element[]>();
  private _testIdAttributeToElements = new Map<string, Element[]>();
  private _attrToElements = {
    ['id']: new Map<string, Element[]>(),
    ['data-testid']: new Map<string, Element[]>(),
    ['data-test-id']: new Map<string, Element[]>(),
    ['data-test']: new Map<string, Element[]>(),
  };
  private _altElements: Element[] = [];
  private _placeholderElements: Element[] = [];
  private _titleToElements = new Map<string, Element[]>();
  private _labelledElements = new Map<Element, { full: string, lowerCase: string }[]>();

  constructor(injected: InjectedScript) {
    this._injected = injected;
  }

  generateSelector(targetElement: Element, options: GenerateSelectorOptions): { selector: string, elements: Element[] } {
    options.retargetForText = true;
    // TODO: detect lists and disallow text from all siblings (but first go up while text matches)
    options.omitTextFrom = targetElement;

    counters = {};

    if (options.retargetForAction)
      targetElement = this._retargetForAction(targetElement) || targetElement;

    const root = options.root ?? this._injected.document;
    if (targetElement === options.root)
      return { selector: ':scope', elements: [targetElement] };

    this._preprocessTree(root, targetElement, options);

    console.time('generate');

    const result = new SelectorCandidateCollection();
    result.updateWithCollection(this._generateWithRelatives(root, targetElement, options));

    if (options.retargetForText) {
      const text = this._getElementText(targetElement);
      for (let parent = parentElementOrShadowHost(targetElement); parent && parent !== root; parent = parentElementOrShadowHost(parent)) {
        if (this._getElementText(parent) === text)
          result.updateWithCollection(this._generateWithRelatives(root, parent, options));
      }
    }

    console.timeEnd('generate');
    for (const prop of ['_elementToCSSToken', '_elementToText', '_elementToChainWithText', '_elementToChainWithoutText', '_elementToRoleLists', '_elementToRole', '_elementToAccessibleName', '_roleToElements', '_textToElements', '_testIdAttributeToElements', '_titleToElements'])
      counters[prop + 'Size'] = (this as any)[prop].size;
    console.log(counters);

    const selector = result.best()!.selector();
    return { selector, elements: this._injected.querySelectorAll(this._injected.parseSelector(selector), root) };
  }

  private _preprocessTree(root: Element | Document, targetElement: Element, options: GenerateSelectorOptions) {
    console.time('prepare');
    const allElements = this._injected._evaluator._queryCSS({ scope: root, pierceShadow: true }, '*');
    for (const element of allElements) {
      const role = this._getElementRole(element);
      if (role)
        pushToListMap(this._roleToElements, role, element);

      const text = this._getElementText(element).full;
      if (text && text.length <= 80)
        pushToListMap(this._textToElements, text, element);

      const testId = targetElement.getAttribute(options.testIdAttributeName);
      if (testId)
        pushToListMap(this._testIdAttributeToElements, testId, element);

      for (const attr of ['id', 'data-testid', 'data-test-id', 'data-test'] as const) {
        const value = targetElement.getAttribute(options.testIdAttributeName);
        if (value)
          pushToListMap(this._attrToElements[attr], value, element);
      }

      if (element.getAttribute('alt'))
        this._altElements.push(element);

      if (element.getAttribute('placeholder'))
        this._placeholderElements.push(element);

      const title = targetElement.getAttribute('title');
      if (title)
        pushToListMap(this._titleToElements, normalizeWhiteSpace(title), element);

      const labels = getElementLabels(this._injected._evaluator._cacheText, element);
      if (labels.length) {
        const list: { full: string, lowerCase: string }[] = [];
        for (const label of labels) {
          const full = normalizeWhiteSpace(label.full.trim());
          list.push({ full, lowerCase: full.toLowerCase() });
        }
        this._labelledElements.set(element, list);
      }
    }
    console.timeEnd('prepare');
  }

  private _generateWithRelatives(root: Element | Document, targetElement: Element, options: GenerateSelectorOptions): SelectorCandidateCollection {
    counters.relative = 1 + (counters.relative || 0);
    const result = new SelectorCandidateCollection();
    for (let ancestor: Element | undefined = targetElement; ancestor && ancestor !== root; ancestor = parentElementOrShadowHost(ancestor)) {
      const lastMile = ancestor !== targetElement ? this._generateWithoutChaining(ancestor, targetElement, options, true) : undefined;
      for (const relative of shallowDescendants(ancestor, 4, 100)) {
        let collection = this._generateWithChaining(root, relative, options, true);
        if (relative !== ancestor)
          collection = collection.chain(this._generateParent(relative, ancestor));
        if (lastMile)
          collection = collection.chain(lastMile);
        result.updateWithCollection(collection);
      }
    }
    return result;
  }

  private _generateParent(from: Element, to: Element): SelectorCandidateCollection {
    counters.parent = 1 + (counters.parent || 0);
    const result = new SelectorCandidateCollection();
    const path: string[] = [];
    while (from !== to) {
      const parent = parentElementOrShadowHost(from);
      if (!parent)
        break;
      path.push('..');
      from = parent;
    }
    result.updateWithCandidate(new SelectorCandidate([{ engine: 'xpath', xpath: path.join('/'), score: kXPathParentsScore }]));
    return result;
  }

  private _generateWithChaining(root: Element | Document, targetElement: Element, options: GenerateSelectorOptions, allowTextEngine: boolean): SelectorCandidateCollection {
    counters.chaining = 1 + (counters.chaining || 0);
    const cache = allowTextEngine ? this._elementToChainWithText : this._elementToChainWithoutText;
    let bestForElement = cache.get(targetElement);
    if (!bestForElement) {
      counters.chaining2 = 1 + (counters.chaining2 || 0);
      bestForElement = new SelectorCandidateCollection();
      bestForElement.updateWithCollection(this._generateWithoutChaining(root, targetElement, options, allowTextEngine));
      for (let parent = parentElementOrShadowHost(targetElement); parent && parent !== root; parent = parentElementOrShadowHost(parent)) {
        const collection = this._generateWithChaining(root, parent, options, false);
        bestForElement.updateWithCollection(collection.chain(this._generateWithoutChaining(parent, targetElement, options, allowTextEngine)));
      }
      cache.set(targetElement, bestForElement);
    }
    return bestForElement;
  }

  private _generateWithoutChaining(root: Element | Document, targetElement: Element, options: GenerateSelectorOptions, allowTextEngine: boolean): SelectorCandidateCollection {
    counters.noChaining = 1 + (counters.noChaining || 0);
    const collection = new SelectorCandidateCollection();
    this._tryInternalEngines(root, targetElement, collection, options);
    this._tryRole(root, targetElement, collection, options);
    this._tryCSS(root, targetElement, collection, options);
    if (allowTextEngine)
      this._tryText(root, targetElement, collection, options);
    if (!collection.best())
      collection.updateWithCandidate(this._lazyCSSSelector(root, targetElement));
    return collection;
  }

  private _tryInternalEngines(root: Element | Document, targetElement: Element, collection: SelectorCandidateCollection, options: GenerateSelectorOptions) {
    if (options.omitInternalEngines || targetElement.nodeName === 'FRAME' || targetElement.nodeName === 'IFRAME')
      return;
    counters.internal = 1 + (counters.internal || 0);

    const tryUpdate = (token: SelectorToken, elements: Element[]) => {
      let candidate = new SelectorCandidate([token]);
      if (elements.length > 1)
        candidate = candidate.appendNth(elements.indexOf(targetElement), elements.length);
      collection.updateWithCandidate(candidate);
    };

    const testId = targetElement.getAttribute(options.testIdAttributeName);
    if (testId)
      tryUpdate({ engine: 'testId', testId, exact: true, score: kTestIdScore }, (this._testIdAttributeToElements.get(testId) || []).filter(e => isInsideScope(root, e)));

    if (targetElement.nodeName === 'INPUT' || targetElement.nodeName === 'TEXTAREA') {
      const input = targetElement as HTMLInputElement | HTMLTextAreaElement;
      if (input.placeholder) {
        const placeholder = input.placeholder;
        const strictElements = this._placeholderElements.filter(e => isInsideScope(root, e)).filter(e => e.getAttribute('placeholder') === placeholder);
        tryUpdate({ engine: 'attr', attr: 'placeholder', value: placeholder, exact: true, score: kPlaceholderScore + kExactPenalty }, strictElements);

        const lax = placeholder.toLowerCase();
        const laxElements = this._placeholderElements.filter(e => isInsideScope(root, e)).filter(e => (e.getAttribute('placeholder') || '').toLowerCase().includes(lax));
        tryUpdate({ engine: 'attr', attr: 'placeholder', value: placeholder, score: kPlaceholderScore }, laxElements);
      }
    }

    if (targetElement.getAttribute('alt') && ['APPLET', 'AREA', 'IMG', 'INPUT'].includes(targetElement.nodeName)) {
      const alt = targetElement.getAttribute('alt')!;
      const strictElements = this._altElements.filter(e => isInsideScope(root, e)).filter(e => e.getAttribute('alt') === alt);
      tryUpdate({ engine: 'attr', attr: 'placeholder', value: alt, exact: true, score: kAltTextScore + kExactPenalty }, strictElements);

      const lax = alt.toLowerCase();
      const laxElements = this._altElements.filter(e => isInsideScope(root, e)).filter(e => (e.getAttribute('alt') || '').toLowerCase().includes(lax));
      tryUpdate({ engine: 'attr', attr: 'placeholder', value: alt, score: kAltTextScore }, laxElements);
    }

    let title = targetElement.getAttribute('title');
    if (title) {
      title = normalizeWhiteSpace(title);
      tryUpdate({ engine: 'attr', attr: 'title', value: title, exact: true, score: kTitleScore + kExactPenalty }, (this._titleToElements.get(title) || []).filter(e => isInsideScope(root, e)));
    }

    // const labels = getElementLabels(injectedScript._evaluator._cacheText, element);
    // for (const label of labels) {
    //   const labelText = label.full.trim();
    //   candidates.push({ engine: 'internal:label', selector: escapeForTextSelector(labelText, false), score: kLabelScore });
    //   candidates.push({ engine: 'internal:label', selector: escapeForTextSelector(labelText, true), score: kLabelScoreExact });
    // }
  }

  private _tryCSS(root: Element | Document, targetElement: Element, collection: SelectorCandidateCollection, options: GenerateSelectorOptions) {
    counters.tryCss = 1 + (counters.tryCss || 0);

    const tryUpdate = (token: SelectorToken, elements: Element[]) => {
      let candidate = new SelectorCandidate([token]);
      if (elements.length > 1)
        candidate = candidate.appendNth(elements.indexOf(targetElement), elements.length);
      collection.updateWithCandidate(candidate);
    };

    const id = targetElement.getAttribute('id');
    if (id && isGuidLike(id)) {
      const css = /^[a-zA-Z][a-zA-Z0-9\-\_]+$/.test(id) ? '#' + id : `[id=${quoteAttributeValue(id)}]`;
      tryUpdate({ engine: 'css', css: () => css, score: kCSSIdScore }, (this._attrToElements.id.get(id) || []).filter(e => isInsideScope(root, e)));
    }

    for (const attr of ['data-testid', 'data-test-id', 'data-test'] as const) {
      const value = targetElement.getAttribute(attr);
      if (value && (attr !== options.testIdAttributeName || targetElement.nodeName === 'FRAME' || targetElement.nodeName === 'IFRAME')) {
        const css = `[${attr}=${quoteAttributeValue(value)}]`;
        tryUpdate({ engine: 'css', css: () => css, score: kOtherTestIdScore }, (this._attrToElements[attr].get(value) || []).filter(e => isInsideScope(root, e)));
      }
    }

    const cssCandidates: { css: string, score: number }[] = [];

    if (targetElement.nodeName === 'FRAME' || targetElement.nodeName === 'IFRAME') {
      for (const attribute of ['name', 'title']) {
        if (targetElement.getAttribute(attribute)) {
          const css = `${cssEscape(targetElement.nodeName.toLowerCase())}[${attribute}=${quoteAttributeValue(targetElement.getAttribute(attribute)!)}]`;
          cssCandidates.push({ css, score: kIframeByAttributeScore });
        }
      }
    }

    if (['INPUT', 'TEXTAREA'].includes(targetElement.nodeName) && targetElement.getAttribute('type') !== 'hidden') {
      if (targetElement.getAttribute('type')) {
        const css = `${cssEscape(targetElement.nodeName.toLowerCase())}[type=${quoteAttributeValue(targetElement.getAttribute('type')!)}]`;
        cssCandidates.push({ css, score: kCSSInputTypeNameScore });
      }
    }

    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(targetElement.nodeName) && targetElement.getAttribute('type') !== 'hidden') {
      const css = cssEscape(targetElement.nodeName.toLowerCase());
      cssCandidates.push({ css, score: kCSSInputTypeNameScore + 1 });
    }

    if (targetElement.getAttribute('name') && ['BUTTON', 'FORM', 'FIELDSET', 'FRAME', 'IFRAME', 'INPUT', 'KEYGEN', 'OBJECT', 'OUTPUT', 'SELECT', 'TEXTAREA', 'MAP', 'META', 'PARAM'].includes(targetElement.nodeName)) {
      const css = `${cssEscape(targetElement.nodeName.toLowerCase())}[name=${quoteAttributeValue(targetElement.getAttribute('name')!)}]`;
      cssCandidates.push({ css, score: kCSSInputTypeNameScore });
    }

    for (const { css, score } of cssCandidates) {
      const elements = this._injected._evaluator._queryCSS({ scope: root, pierceShadow: true }, css);
      let candidate = new SelectorCandidate([{ engine: 'css', css: () => css, score }]);
      if (elements.length > 1)
        candidate = candidate.appendNth(elements.indexOf(targetElement), elements.length);
      collection.updateWithCandidate(candidate);
    }
  }

  private _tryRole(root: Element | Document, targetElement: Element, collection: SelectorCandidateCollection, options: GenerateSelectorOptions) {
    if (options.omitInternalEngines)
      return;

    const role = this._getElementRole(targetElement);
    if (!role)
      return;

    counters.role = 1 + (counters.role || 0);
    const elements = this._getRoleList(root, role);
    let candidateWithoutName = new SelectorCandidate([{ engine: 'role', role, score: kRoleWithoutNameScore }]);
    if (elements.length > 1)
      candidateWithoutName = candidateWithoutName.appendNth(elements.indexOf(targetElement), elements.length);
    collection.updateWithCandidate(candidateWithoutName);

    const { accessibleName, textFrom, upperCase } = this._getElementAccessibleName(targetElement);
    if (options.omitTextFrom && textFrom) {
      if (textFrom.has(options.omitTextFrom))
        return;
      counters.textFrom = textFrom.size + (counters.textFrom || 0);
      if ([...textFrom].some(e => isInsideScope(options.omitTextFrom!, e)))
        return;
    }

    // TODO: we can try shrinking the accessible name while result is still unique.
    for (const exact of [false, true]) {
      const filtered = elements.filter(e => {
        counters.roleFilter = 1 + (counters.roleFilter || 0);
        const entry = this._getElementAccessibleName(e);
        return exact ? entry.accessibleName === accessibleName : entry.upperCase.includes(upperCase);
      });
      let candidateWithName = new SelectorCandidate([{ engine: 'role', role, accessibleName, exact, score: kRoleWithNameScore + textLengthScore(accessibleName) + (exact ? kExactPenalty : 0) }]);
      if (filtered.length > 1)
        candidateWithName = candidateWithName.appendNth(filtered.indexOf(targetElement), filtered.length);
      collection.updateWithCandidate(candidateWithName);
      // No need for exact name matching if non-exact is already unique.
      if (filtered.length === 1)
        break;
    }
  }

  private _tryText(root: Element | Document, targetElement: Element, collection: SelectorCandidateCollection, options: GenerateSelectorOptions) {
    if (options.omitInternalEngines)
      return;

    if (options.omitTextFrom && (isInsideScope(targetElement, options.omitTextFrom) || isInsideScope(options.omitTextFrom, targetElement)))
      return;

    counters.text = 1 + (counters.text || 0);

    // TODO: we can try shrinking text while result is still unique.
    const text = this._getElementText(targetElement);
    const laxText = text.lowerCase.substring(0, 80);
    if (!laxText)
      return;

    // Lax matching is unique iff:
    // - It only occurs once in the root, and so not outside the targetElement.
    // - It does not occur in any of the children, so not inside the targetElement.
    let singleMatchLax = !hasTwoOccurences(this._getElementText(root.nodeType === 9 /* Node.DOCUMENT_NODE */ ? (root as Document).documentElement : root as Element).lowerCase, laxText);
    if (singleMatchLax)
      singleMatchLax = ![...targetElement.children].some(child => this._getElementText(child).lowerCase.includes(laxText));

    // if (!extraMatchesLax) {
    //   const elements = this._injected._evaluator._queryCSS({ scope: root, pierceShadow: true }, '*');
    //   if (root.nodeType === 1 /* Node.ELEMENT_NODE */)
    //     elements.unshift(root as Element);
    //   extraMatchesLax = elements.some(element => {
    //     return element !== targetElement && this._getElementText(element).lowerCase.includes(laxText);
    //   });
    // }

    if (singleMatchLax) {
      collection.updateWithCandidate(new SelectorCandidate([{ engine: 'text', text: laxText, score: kTextScore + textLengthScore(laxText) }]));
      // Skip strict text matching if lax is already unique since it has strictly worse score.
    } else if (text.full.length <= 80) {
      const elements = (this._textToElements.get(text.full) || []).filter(e => isInsideScope(root, e));
      if (elements.length === 1 && elements[0] === targetElement)
        collection.updateWithCandidate(new SelectorCandidate([{ engine: 'text', text: text.full, exact: true, score: kTextScore + textLengthScore(laxText) + kExactPenalty }]));
    }

    return collection;
  }

  private _generateCSSToken(parent: Element, element: Element) {
    let token = this._elementToCSSToken.get(element);
    if (token === undefined) {
      counters.cssToken = 1 + (counters.cssToken || 0);

      token = '';

      const siblings = [...parent.children];
      if (parent.shadowRoot)
        siblings.push(...parent.shadowRoot.children);

      let filtered: Element[] = siblings;
      const tryNarrow = (addToken: string, prepend?: true) => {
        if (filtered.length <= 1)
          return;
        const newToken = prepend ? addToken + token : token + addToken;
        const newFiltered = siblings.filter(e => e.matches(newToken));
        if (newFiltered.length < filtered.length) {
          token = newToken;
          filtered = newFiltered;
        }
      };

      if (element.id)
        tryNarrow('#' + cssEscape(element.id));
      [...element.classList].forEach(cls => tryNarrow('.' + cssEscape(cls)));
      tryNarrow(cssEscape(element.nodeName.toLowerCase()), true);

      if (!token)
        token = cssEscape(element.nodeName.toLowerCase());

      if (filtered.length > 1)
        token += `:nth-child(${1 + [...parent.children].indexOf(element)})`;

      this._elementToCSSToken.set(element, token);
    }
    return token;
  }

  private _lazyCSSSelector(root: Element | Document, targetElement: Element): SelectorCandidate {
    const css = this._generateCSSSelector.bind(this, root, targetElement);
    return new SelectorCandidate([{ engine: 'css', css, score: kCSSFallbackScore }]);
  }

  private _generateCSSSelector(root: Element | Document, targetElement: Element): string {
    if (root.nodeType === 9 /* Node.DOCUMENT_NODE */ && (root as Document).documentElement === targetElement)
      return 'html';

    counters.css = 1 + (counters.css || 0);

    const tokens: string[] = [];
    let first: { token: string, parent: Element } | undefined;
    for (let element: Element = targetElement; element !== root;) {
      const parent = parentElementOrShadowHost(element);
      if (!parent)
        break;
      const token = this._generateCSSToken(parent, element);
      tokens.push(token);
      if (!first)
        first = { token, parent };
      element = parent;
    }
    tokens.reverse();
    return tokens.map(token => '> ' + token).join(' ');
  }

  private _retargetForAction(element: Element | undefined): Element | undefined {
    if (!element)
      return;
    const role = getAriaRole(element);
    if (['button', 'checkbox', 'spinbutton', 'radio', 'slider', 'listbox', 'combobox', 'searchbox', 'textbox', 'link'].includes(role || ''))
      return element;
    return this._retargetForAction(parentElementOrShadowHost(element));
  }

  private _getElementText(element: Element) {
    counters.elementTextBeforeMap = 1 + (counters.elementTextBeforeMap || 0);
    let text = this._elementToText.get(element);
    if (text === undefined) {
      counters.elementText = 1 + (counters.elementText || 0);
      const full = normalizeWhiteSpace(elementText(this._injected._evaluator._cacheText, element).full);
      text = { full, lowerCase: full.toLowerCase() };
      this._elementToText.set(element, text);
    }
    return text;
  }

  private _getRoleList(root: Element | Document, role: string): Element[] {
    let map = this._elementToRoleLists.get(root);
    if (!map) {
      map = new Map();
      this._elementToRoleLists.set(root, map);
    }
    let elements = map.get(role);
    if (elements === undefined) {
      counters.roleList = 1 + (counters.roleList || 0);
      elements = (this._roleToElements.get(role) || []).filter(e => isInsideScope(root, e));
      map.set(role, elements);
    }
    return elements;
  }

  private _getElementRole(element: Element): string | null {
    let role = this._elementToRole.get(element);
    if (role === undefined) {
      counters.elementRole = 1 + (counters.elementRole || 0);
      role = null;
      if (!isElementHiddenForAria(element))
        role = getAriaRole(element);
      // TODO: explicitly list roles we would like to see?
      if (role === 'presentation' || role === 'none')
        role = null;
      this._elementToRole.set(element, role);
    }
    return role;
  }

  private _getElementAccessibleName(element: Element): AccessibleNameCacheEntry {
    let result = this._elementToAccessibleName.get(element);
    if (result === undefined) {
      counters.elementAccessibleName = 1 + (counters.elementAccessibleName || 0);
      const name = getElementAccessibleName(element, false);
      result = { ...name, upperCase: name.accessibleName.toUpperCase() };
      this._elementToAccessibleName.set(element, result);
    }
    return result;
  }
}

class SelectorCandidate {
  readonly tokens: SelectorToken[];
  readonly score: number;

  constructor(tokens: SelectorToken[]) {
    this.tokens = tokens;
    this.score = tokens.reduce((acc, token) => acc + token.score, 0) + (tokens.length - 1) * (tokens.length - 1) * kChainScorePenalty;
  }

  appendNth(index: number, total: number) {
    return new SelectorCandidate([...this.tokens, { engine: 'nth', index, score: Math.min(kNthScoreMax, kNthScoreMin * ((1 + index / 4) | 0)) }]);
  }

  append(other: SelectorCandidate) {
    return new SelectorCandidate([...this.tokens, ...other.tokens]);
  }

  selector() {
    return this.tokens.map(token => this._stringifyToken(token)).join(' >> ');
  }

  private _stringifyToken(token: SelectorToken): string {
    switch (token.engine) {
      case 'css': return token.css();
      case 'nth': return `nth=${token.index}`;
      case 'text': return `internal:text=${escapeForTextSelector(token.text, !!token.exact)}`;
      case 'testId': return `internal:testid=${escapeForAttributeSelector(token.testId, !!token.exact)}`;
      case 'xpath': return token.xpath.startsWith('..') ? token.xpath : `xpath=${token.xpath}`;
      case 'attr': return `internal:attr=[${token.attr}=${escapeForAttributeSelector(token.value, !!token.exact)}]`;
      case 'role': {
        const name = token.accessibleName ? `[name=${escapeForAttributeSelector(token.accessibleName, !!token.exact)}]` : '';
        return `internal:role=${token.role}${name}`;
      }
    }
    throw new Error(`Unknown engine in token ${JSON.stringify(token)}`);
  }
}

class SelectorCandidateCollection {
  private _best: SelectorCandidate | undefined;

  updateWithCollection(other: SelectorCandidateCollection) {
    if (other._best)
      this.updateWithCandidate(other._best);
  }

  // TODO: we can make tryUpdate() and avoid extra work for candidates
  // that will not improve this collection.
  updateWithCandidate(candidate: SelectorCandidate) {
    if (!this._best || candidate.score < this._best.score)
      this._best = candidate;
  }

  best() {
    return this._best;
  }

  chain(collection: SelectorCandidateCollection) {
    const result = new SelectorCandidateCollection();
    if (!collection._best || !this._best)
      return result;
    result._best = this._best.append(collection._best);
    return result;
  }
}

function textLengthScore(text: string) {
  return Math.min(kTextLengthMaxPenalty, (text.length / 10) | 0);
}

function shallowDescendants(root: Element, depth: number, total: number, result: Element[] = []) {
  result.push(root);
  if (depth > 0) {
    for (const child of root.children) {
      if (result.length < total)
        shallowDescendants(child, depth - 1, total, result);
    }
    if (root.shadowRoot) {
      for (const child of root.shadowRoot.children) {
        if (result.length < total)
          shallowDescendants(child, depth - 1, total, result);
      }
    }
  }
  return result;
}

function hasTwoOccurences(text: string, substr: string) {
  const first = text.indexOf(substr);
  return first !== -1 && text.indexOf(substr, first + substr.length) !== -1;
}

function isGuidLike(id: string): boolean {
  let lastCharacterType: 'lower' | 'upper' | 'digit' | 'other' | undefined;
  let transitionCount = 0;
  for (let i = 0; i < id.length; ++i) {
    const c = id[i];
    let characterType: 'lower' | 'upper' | 'digit' | 'other';
    if (c === '-' || c === '_')
      continue;
    if (c >= 'a' && c <= 'z')
      characterType = 'lower';
    else if (c >= 'A' && c <= 'Z')
      characterType = 'upper';
    else if (c >= '0' && c <= '9')
      characterType = 'digit';
    else
      characterType = 'other';

    if (characterType === 'lower' && lastCharacterType === 'upper') {
      lastCharacterType = characterType;
      continue;
    }

    if (lastCharacterType && lastCharacterType !== characterType)
      ++transitionCount;
    lastCharacterType = characterType;
  }
  return transitionCount >= id.length / 4;
}

function quoteAttributeValue(text: string): string {
  return `"${cssEscape(text).replace(/\\ /g, ' ')}"`;
}

function pushToListMap(map: Map<string, Element[]>, key: string, element: Element) {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  list.push(element);
}
