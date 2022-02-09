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

import { closestCrossShadow, enclosingShadowRootOrDocument, parentElementOrShadowHost } from './selectorEvaluator';

function hasExplicitAccessibleName(e: Element) {
  return e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby');
}

// https://www.w3.org/TR/wai-aria-practices/examples/landmarks/HTML5.html
const kAncestorPreventingLandmark = 'article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), section:not([role]), [role=article], [role=complementary], [role=main], [role=navigation], [role=region]';

// https://raw.githack.com/w3c/aria/stable/#global_states
const kGlobalAriaAttributes = [
  'aria-atomic',
  'aria-busy',
  'aria-controls',
  'aria-current',
  'aria-describedby',
  'aria-details',
  'aria-disabled',
  'aria-dropeffect',
  'aria-errormessage',
  'aria-flowto',
  'aria-grabbed',
  'aria-haspopup',
  'aria-hidden',
  'aria-invalid',
  'aria-keyshortcuts',
  'aria-label',
  'aria-labelledby',
  'aria-live',
  'aria-owns',
  'aria-relevant',
  'aria-roledescription',
];

function hasGlobalAriaAttribute(e: Element) {
  return kGlobalAriaAttributes.some(a => e.hasAttribute(a));
}

const kImplicitRoleByTagName: { [tagName: string]: (e: Element) => string | null } = {
  'A': (e: Element) => {
    return e.hasAttribute('href') ? 'link' : null;
  },
  'AREA': (e: Element) => {
    return e.hasAttribute('href') ? 'link' : null;
  },
  'ARTICLE': () => 'article',
  'ASIDE': () => 'complementary',
  'BODY': () => 'document',
  'BUTTON': () => 'button',
  'DATALIST': () => 'listbox',
  'DD': () => 'definition',
  'DFN': () => 'term',
  'DETAILS': () => 'group',
  'DIALOG': () => 'dialog',
  'DT': () => 'term',
  'FIELDSET': () => 'group',
  'FIGURE': () => 'figure',
  'FOOTER': (e: Element) => closestCrossShadow(e, kAncestorPreventingLandmark) ? null : 'contentinfo',
  'FORM': (e: Element) => hasExplicitAccessibleName(e) ? 'form' : null,
  'H1': () => 'heading',
  'H2': () => 'heading',
  'H3': () => 'heading',
  'H4': () => 'heading',
  'H5': () => 'heading',
  'H6': () => 'heading',
  'HEADER': (e: Element) => closestCrossShadow(e, kAncestorPreventingLandmark) ? null : 'banner',
  'HR': () => 'separator',
  'IMG': (e: Element) => e.getAttribute('alt') || hasGlobalAriaAttribute(e) ? 'img' : 'presentation',
  'INPUT': (e: Element) => {
    const type = (e as HTMLInputElement).type.toLowerCase();
    if (type === 'search')
      return e.hasAttribute('list') ? 'combobox' : 'searchbox';
    if (['email', 'tel', 'text', 'url', ''].includes(type))
      return e.hasAttribute('list') ? 'combobox' : 'textbox';
    return {
      'button': 'button',
      'checkbox': 'checkbox',
      'image': 'button',
      'number': 'spinbutton',
      'radio': 'radio',
      'range': 'slider',
      'reset': 'button',
      'submit': 'button',
    }[type] || 'textbox';
  },
  'LI': () => 'listitem',
  'MAIN': () => 'main',
  'MATH': () => 'math',
  'MENU': () => 'list',
  'NAV': () => 'navigation',
  'OL': () => 'list',
  'OPTGROUP': () => 'group',
  'OPTION': () => 'option',
  'OUTPUT': () => 'status',
  'PROGRESS': () => 'progressbar',
  'SECTION': (e: Element) => hasExplicitAccessibleName(e) ? 'region' : null,
  'SELECT': (e: Element) => e.hasAttribute('multiple') || (e as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox',
  'SUMMARY': () => 'button',
  'TABLE': () => 'table',
  'TBODY': () => 'rowgroup',
  'TD': (e: Element) => {
    const table = closestCrossShadow(e, 'table');
    const role = table ? getExplicitAriaRole(table) : '';
    return (role === 'grid' || role === 'treegrid') ? 'gridcell' : 'cell';
  },
  'TEXTAREA': () => 'textbox',
  'TFOOT': () => 'rowgroup',
  'TH': (e: Element) => {
    if (e.getAttribute('scope') === 'col')
      return 'columnheader';
    if (e.getAttribute('scope') === 'row')
      return 'rowheader';
    return null;
  },
  'THEAD': () => 'rowgroup',
  'TR': () => 'row',
  'UL': () => 'list',
};

const kPresentationInheritanceParents: { [tagName: string]: string[] } = {
  'DD': ['DL', 'DIV'],
  'DIV': ['DL'],
  'DT': ['DL', 'DIV'],
  'LI': ['OL', 'UL'],
  'TBODY': ['TABLE'],
  'TD': ['TR'],
  'TFOOT': ['TABLE'],
  'TH': ['TR'],
  'THEAD': ['TABLE'],
  'TR': ['THEAD', 'TBODY', 'TFOOT', 'TABLE'],
};

function getImplicitAriaRole(element: Element): string | null {
  const implicitRole = kImplicitRoleByTagName[element.tagName]?.(element) || '';
  if (!implicitRole)
    return null;
  // Inherit presentation role when required.
  // https://www.w3.org/TR/wai-aria-1.2/#conflict_resolution_presentation_none
  let ancestor: Element | null = element;
  while (ancestor) {
    const parent = parentElementOrShadowHost(ancestor);
    const parents = kPresentationInheritanceParents[ancestor.tagName];
    if (!parents || !parent || !parents.includes(parent.tagName))
      break;
    const parentExplicitRole = getExplicitAriaRole(parent);
    if ((parentExplicitRole === 'none' || parentExplicitRole === 'presentation') && !hasPresentationConflictResolution(parent))
      return parentExplicitRole;
    ancestor = parent;
  }
  return implicitRole;
}

function getExplicitAriaRole(element: Element): string | null {
  const explicitRole = element.getAttribute('role');
  return (explicitRole || '').trim().split(' ')[0] || null;
}

function hasPresentationConflictResolution(element: Element) {
  // https://www.w3.org/TR/wai-aria-1.2/#conflict_resolution_presentation_none
  // TODO: this should include "|| focusable" check.
  return !hasGlobalAriaAttribute(element);
}

export function getAriaRole(element: Element): string | null {
  const explicitRole = getExplicitAriaRole(element);
  if (!explicitRole)
    return getImplicitAriaRole(element);
  if ((explicitRole === 'none' || explicitRole === 'presentation') && hasPresentationConflictResolution(element))
    return getImplicitAriaRole(element);
  return explicitRole;
}

export function getAriaBoolean(attr: string | null) {
  return attr === null ? undefined : attr.toLowerCase() === 'true';
}

function getComputedStyle(element: Element, pseudo?: string): CSSStyleDeclaration | undefined {
  return element.ownerDocument && element.ownerDocument.defaultView ? element.ownerDocument.defaultView.getComputedStyle(element, pseudo) : undefined;
}

export function isElementHiddenForRole(element: Element, cache: Map<Element, boolean>): boolean {
  if (['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE'].includes(element.tagName))
    return true;

  let style: CSSStyleDeclaration | undefined = getComputedStyle(element);
  if (!style || style.visibility === 'hidden')
    return true;

  let parent: Element | undefined = element;
  while (parent) {
    if (!cache.has(parent)) {
      if (!style)
        style = getComputedStyle(parent);
      const hidden = !style || style.display === 'none' || getAriaBoolean(parent.getAttribute('aria-hidden')) === true;
      cache.set(parent, hidden);
    }
    if (cache.get(parent)!)
      return true;
    parent = parentElementOrShadowHost(parent);
  }
  return false;
}

function getIdRefs(element: Element, ref: string | null): Element[] {
  if (!ref)
    return [];
  const root = enclosingShadowRootOrDocument(element);
  if (!root)
    return [];
  try {
    return Array.from(root.querySelectorAll(ref));
  } catch (e) {
    return [];
  }
}

function normalizeAccessbileName(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\u00A0/g, ' ').replace(/\s\s+/g, ' ').trim();
}

function queryInAriaOwned(element: Element, selector: string): Element[] {
  const result = [...element.querySelectorAll(selector)];
  for (const owned of getIdRefs(element, element.getAttribute('aria-owns')))
    result.push(...owned.querySelectorAll(selector));
  return result;
}

function getPseudoContent(pseudoStyle: CSSStyleDeclaration | undefined) {
  if (!pseudoStyle)
    return '';
	const content = pseudoStyle.getPropertyValue('content');
  if ((content[0] === '\'' && content[content.length - 1] === '\'') ||
      (content[0] === '"' && content[content.length - 1] === '"')) {
    return content.substring(1, content.length - 1);
  }
  return '';
}

export function getElementAccessibleName(element: Element, includeHidden: boolean, hiddenCache: Map<Element, boolean>): string {
  // https://w3c.github.io/accname/#computation-steps

  // step 1.
  // https://w3c.github.io/aria/#namefromprohibited
  const elementProhibitsNaming = ['caption', 'code', 'definition', 'deletion', 'emphasis', 'generic', 'insertion', 'mark', 'paragraph', 'presentation', 'strong', 'subscript', 'suggestion', 'superscript', 'term', 'time'].includes(getAriaRole(element) || '');
  if (elementProhibitsNaming)
    return '';

  const accessibleName = normalizeAccessbileName(getElementAccessibleNameInternal(element, {
    includeHidden,
    hiddenCache,
    visitedElements: new Set(),
    embeddedInLabelledBy: 'none',
    embeddedInLabel: false,
    embeddedInTextAlternativeElement: false,
    embeddedInTargetElement: true,
  }));
  return accessibleName;
}

type AccessibleNameOptions = {
  includeHidden: boolean,
  hiddenCache: Map<Element, boolean>,
  visitedElements: Set<Element>,
  embeddedInLabelledBy: 'none' | 'self' | 'descendant',
  embeddedInLabel: boolean,
  embeddedInTextAlternativeElement: boolean,
  embeddedInTargetElement: boolean,
};

function getElementAccessibleNameInternal(element: Element, options: AccessibleNameOptions): string {
  if (options.visitedElements.has(element))
    return '';
  options.visitedElements.add(element);

  const childOptions: AccessibleNameOptions = {
    ...options,
    embeddedInLabelledBy: options.embeddedInLabelledBy === 'self' ? 'descendant' : options.embeddedInLabelledBy,
  };

  // step 2a.
  if (!options.includeHidden && options.embeddedInLabelledBy !== 'self' && isElementHiddenForRole(element, options.hiddenCache))
    return '';

  // step 2b.
  if (options.embeddedInLabelledBy === 'none') {
    const refs = getIdRefs(element, element.getAttribute('aria-labelledby'));
    const accessibleName = refs.map(ref => getElementAccessibleNameInternal(ref, {
      ...options,
      embeddedInLabelledBy: 'self',
      embeddedInTargetElement: false,
      embeddedInLabel: true,
      embeddedInTextAlternativeElement: false,
    })).join(' ');
    if (accessibleName)
      return accessibleName;
  }

  const role = getAriaRole(element) || '';

  // step 2c.
  if (options.embeddedInLabel || options.embeddedInLabelledBy !== 'none') {
    if (role === 'textbox') {
      if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')
        return (element as HTMLInputElement | HTMLTextAreaElement).value;
      return element.textContent || '';
    }
    if (['combobox', 'listbox'].includes(role)) {
      let options: Element[];
      if (element.tagName === 'SELECT') {
        options = [...(element as HTMLSelectElement).selectedOptions];
        if (!options.length && (element as HTMLSelectElement).options.length)
          options.push((element as HTMLSelectElement).options[0]);
      } else {
        const listbox = role === 'combobox' ? queryInAriaOwned(element, '*').find(e => getAriaRole(e) === 'listbox') : element;
        options = listbox ? queryInAriaOwned(listbox, '[aria-selected="true"]').filter(e => getAriaRole(e) === 'option') : [];
      }
      return options.map(option => getElementAccessibleNameInternal(option, childOptions)).join(' ');
    }
    if (['progressbar', 'scrollbar', 'slider', 'spinbutton', 'meter'].includes(role)) {
      if (element.hasAttribute('aria-valuetext'))
        return element.getAttribute('aria-valuetext') || '';
      if (element.hasAttribute('aria-valuenow'))
        return element.getAttribute('aria-valuenow') || '';
      return element.getAttribute('value') || '';
    }
  }

  // step 2d.
  const ariaLabel = element.getAttribute('aria-label') || '';
  if (ariaLabel.trim())
    return ariaLabel;

  // step 2e.
  if (!['presentation', 'none'].includes(role)) {
    // https://w3c.github.io/html-aam/#input-type-button-input-type-submit-and-input-type-reset
    if (element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes((element as HTMLInputElement).type)) {
      const value = (element as HTMLInputElement).value || '';
      if (value.trim())
        return value;
      if ((element as HTMLInputElement).type === 'submit')
        return 'Submit';
      if ((element as HTMLInputElement).type === 'reset')
        return 'Reset';
    }

    // https://w3c.github.io/html-aam/#input-type-image
    if (element.tagName === 'INPUT' && (element as HTMLInputElement).type === 'image') {
      const alt = element.getAttribute('alt') || '';
      if (alt.trim())
        return alt;
      const title = element.getAttribute('title') || '';
      if (title.trim())
        return title;
      return 'Submit';
    }

    // https://w3c.github.io/html-aam/#input-type-text-input-type-password-input-type-search-input-type-tel-input-type-url-and-textarea-element
    // https://w3c.github.io/html-aam/#other-form-elements
    // For "other form elements", we count select and any other input.
    if (element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.tagName === 'INPUT') {
      const labels = (element as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)).labels || [];
      if (labels.length) {
        return [...labels].map(label => getElementAccessibleNameInternal(label, {
          ...options,
          embeddedInLabel: true,
          embeddedInTextAlternativeElement: false,
          embeddedInLabelledBy: 'none',
          embeddedInTargetElement: false,
        })).filter(accessibleName => !!accessibleName).join(' ');
      }

      const usePlaceholder = (element.tagName === 'INPUT' && ['text', 'password', 'search', 'tel', 'email', 'url'].includes((element as HTMLInputElement).type)) || element.tagName === 'TEXTAREA';
      const placeholder = element.getAttribute('placeholder') || '';
      if (usePlaceholder && placeholder.trim())
        return placeholder;
    }

    // https://w3c.github.io/html-aam/#fieldset-and-legend-elements
		if (element.tagName === 'FIELDSET') {
      for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        if (child.tagName === 'LEGEND') {
          return getElementAccessibleNameInternal(child, {
            ...childOptions,
            embeddedInTextAlternativeElement: true,
          });
        }
      }
    }

    // https://w3c.github.io/html-aam/#figure-and-figcaption-elements
		if (element.tagName === 'FIGURE') {
      for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        if (child.tagName === 'FIGCAPTION') {
          return getElementAccessibleNameInternal(child, {
            ...childOptions,
            embeddedInTextAlternativeElement: true,
          });
        }
      }
    }

    // https://w3c.github.io/html-aam/#img-element
		if (element.tagName === 'IMG') {
      const alt = element.getAttribute('alt') || '';
      if (alt.trim())
        return alt;
    }

    // https://w3c.github.io/html-aam/#table-element
		if (element.tagName === 'TABLE') {
      for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        if (child.tagName === 'CAPTION') {
          return getElementAccessibleNameInternal(child, {
            ...childOptions,
            embeddedInTextAlternativeElement: true,
          });
        }
      }
    }

    // https://w3c.github.io/html-aam/#area-element
		if (element.tagName === 'AREA') {
      const alt = element.getAttribute('alt') || '';
      if (alt.trim())
        return alt;
    }

    // https://www.w3.org/TR/svg-aam-1.0/
		if (element.tagName === 'SVG' && (element as SVGElement).ownerSVGElement) {
      for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        if (child.tagName === 'TITLE' && (element as SVGElement).ownerSVGElement) {
          return getElementAccessibleNameInternal(child, {
            ...childOptions,
            embeddedInTextAlternativeElement: true,
          });
        }
      }
    }
  }

  // step 2f + step 2h.
  // https://w3c.github.io/aria/#namefromcontent
  const allowsNameFromContent = ['button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem'].includes(role);
  if (allowsNameFromContent || options.embeddedInLabelledBy === 'self' || options.embeddedInLabel || options.embeddedInTextAlternativeElement) {
    const tokens: string[] = [];
    const visit = (node: Node) => {
      if (node.nodeType === 1 /* Node.ELEMENT_NODE */) {
        tokens.push(getElementAccessibleNameInternal(node as Element, childOptions));
      } else if (node.nodeType === 3 /* Node.TEXT_NODE */) {
        // step 2g.
        tokens.push(node.textContent || '');
      }
    };
    tokens.push(getPseudoContent(getComputedStyle(element, '::before')));
    for (let child = element.firstChild; child; child = child.nextSibling)
      visit(child);
    if (element.shadowRoot) {
      for (let child = element.shadowRoot.firstChild; child; child = child.nextSibling)
        visit(child);
    }
    for (const owned of getIdRefs(element, element.getAttribute('aria-owns')))
      visit(owned);
    tokens.push(getPseudoContent(getComputedStyle(element, '::after')));
    return tokens.filter(token => !!token).join(' ');
  }

  // step 2i.
  if (!['presentation', 'none'].includes(role) || element.tagName === 'IFRAME') {
    const title = element.getAttribute('title') || '';
    if (title.trim())
      return title;
  }

  return '';
}
