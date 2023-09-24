/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { FrameSnapshot, NodeSnapshot } from '@trace/snapshot';

export function generateSnapshotRendererHTML(snapshots: FrameSnapshot[]) {
  return `<html><head></head><body><script>window.SNAPSHOTS=${JSON.stringify(snapshots)}; ${incrementalScript()}</script></body></html>`;
}

function incrementalScript() {
  function loadSnapshots() {
    type Ref = [number, number];
    type NodeId = [number, number];

    const snapshots: FrameSnapshot[] = (window as any).SNAPSHOTS;
    const idSymbol = Symbol('nodeId');

    /**
     * Best-effort Electron support: rewrite custom protocol in DOM.
     * vscode-file://vscode-app/ -> https://pw-vscode-file--vscode-app/
     */
    const schemas = ['about:', 'blob:', 'data:', 'file:', 'ftp:', 'http:', 'https:', 'mailto:', 'sftp:', 'ws:', 'wss:'];
    const kLegacyBlobPrefix = 'http://playwright.bloburl/#';

    function rewriteURLForCustomProtocol(href: string): string {
      // Legacy support, we used to prepend this to blobs, strip it away.
      if (href.startsWith(kLegacyBlobPrefix))
        href = href.substring(kLegacyBlobPrefix.length);

      try {
        const url = new URL(href);
        // Sanitize URL.
        if (url.protocol === 'javascript:' || url.protocol === 'vbscript:')
          return 'javascript:void(0)';

        // Pass through if possible.
        const isBlob = url.protocol === 'blob:';
        if (!isBlob && schemas.includes(url.protocol))
          return href;

        // Rewrite blob and custom schemas.
        const prefix = 'pw-' + url.protocol.slice(0, url.protocol.length - 1);
        url.protocol = 'https:';
        url.hostname = url.hostname ? `${prefix}--${url.hostname}` : prefix;
        return url.toString();
      } catch {
        return href;
      }
    }

    /**
     * Best-effort Electron support: rewrite custom protocol in inline stylesheets.
     * vscode-file://vscode-app/ -> https://pw-vscode-file--vscode-app/
     */
    const urlInCSSRegex = /url\(['"]?([\w-]+:)\/\//ig;

    function rewriteURLsInStyleSheetForCustomProtocol(text: string): string {
      return text.replace(urlInCSSRegex, (match: string, protocol: string) => {
        const isBlob = protocol === 'blob:';
        if (!isBlob && schemas.includes(protocol))
          return match;
        return match.replace(protocol + '//', `https://pw-${protocol.slice(0, -1)}--`);
      });
    }

    function snapshotNodes(snapshot: FrameSnapshot): NodeSnapshot[] {
      if (!(snapshot as any)._nodes) {
        const nodes: NodeSnapshot[] = [];
        const visit = (n: NodeSnapshot) => {
          if (typeof n === 'string') {
            nodes.push(n);
          } else if (typeof n[0] === 'string') {
            for (let i = 2; i < n.length; i++)
              visit(n[i]);
            nodes.push(n);
          }
        };
        visit(snapshot.html);
        (snapshot as any)._nodes = nodes;
      }
      return (snapshot as any)._nodes;
    }

    let scrollTops = new Map<Element, number>();
    let scrollLefts = new Map<Element, number>();
    let targetElements = new Map<Element, { outline: string, backgroundColor: string }>();
    let targetIds: (string | undefined)[] = [];

    function reconcileAttributes(e: Element, snapshotAttrs: Record<string, string>) {
      const attrs: Record<string, string> = {};
      const isImgWithCurrentSrc = e.nodeName === 'IMG' && snapshotAttrs['__playwright_current_src__'] !== undefined;
      const isSourceInsidePictureWithCurrentSrc = e.nodeName === 'SOURCE' && e.parentElement?.nodeName === 'PICTURE' && e.parentElement.hasAttribute('__playwright_current_src__');
      for (const [attrName, attrValue] of Object.entries(snapshotAttrs)) {
        if (attrName === '__playwright_scroll_top_') {
          scrollTops.set(e, +attrValue);
          continue;
        }
        if (attrName === '__playwright_scroll_left_') {
          scrollLefts.set(e, +attrValue);
          continue;
        }
        if (attrName === '__playwright_value_') {
          (e as HTMLInputElement | HTMLTextAreaElement).value = attrValue;
          continue;
        }
        if (attrName === '__playwright_checked_') {
          (e as HTMLInputElement).checked = attrValue === 'true';
          continue;
        }
        if (attrName === '__playwright_selected_') {
          (e as HTMLOptionElement).selected = attrValue === 'true';
          continue;
        }
        if ((e.nodeName === 'FRAME' || e.nodeName === 'IFRAME') && (attrName === '__playwright_src__' || attrName === 'src')) {
          if (!attrValue) {
            e.setAttribute('src', 'data:text/html,<body style="background: #ddd"></body>');
            continue;
          }
          // Retain query parameters to inherit name=, time=, showPoint= and other values from parent.
          const url = new URL(unwrapPopoutUrl(window.location.href));
          // We can be loading iframe from within iframe, reset base to be absolute.
          const index = url.pathname.lastIndexOf('/snapshot/');
          if (index !== -1)
            url.pathname = url.pathname.substring(0, index + 1);
          url.pathname += attrValue.substring(1);
          e.setAttribute('src', url.toString());
          continue;
        }
        if (e.nodeName === 'A' && attrName.toLowerCase() === 'href') {
          attrs[attrName] = 'link://' + attrValue;
          continue;
        }
        if (e.nodeName === 'IMG' && attrName === '__playwright_current_src__') {
          // Render currentSrc for images, so that trace viewer does not accidentally
          // resolve srcset to a different source.
          attrs['src'] = rewriteURLForCustomProtocol(attrValue);
          continue;
        }
        if (attrName.toLowerCase() === 'href' || attrName.toLowerCase() === 'src' || attrName === '__playwright_current_src__') {
          attrs[attrName] = rewriteURLForCustomProtocol(attrValue);
          continue;
        }
        if (['src', 'srcset'].includes(attrName.toLowerCase()) && (isImgWithCurrentSrc || isSourceInsidePictureWithCurrentSrc)) {
          // Disable actual <img src>, <img srcset>, <source src> and <source srcset> if
          // we will be using the currentSrc instead.
          attrs['_' + attrName] = attrValue;
          continue;
        }
        if (attrName === '__playwright_target__') {
          // const isTarget = (targetIds || []).includes(attrValue);
          // if (isTarget) {
          //   const style = (e as HTMLElement).style;
          //   if (!targetElements.has(e))
          //     targetElements.set(e, { outline: style.outline, backgroundColor: style.backgroundColor });
          //   style.outline = '2px solid #006ab1';
          //   style.backgroundColor = '#6fa8dc7f';
          // } else {
          //   if (targetElements.has(e)) {
          //     const style = (e as HTMLElement).style;
          //     style.outline = targetElements.get(e)!.outline;
          //     style.backgroundColor = targetElements.get(e)!.backgroundColor;
          //     targetElements.delete(e);
          //   }
          // }
          continue;
        }
        attrs[attrName] = attrValue;
      }
      for (const [attrName, attrValue] of Object.entries(attrs))
        e.setAttribute(attrName, attrValue);
      const toRemove: string[] = [];
      for (const attr of e.attributes) {
        if (!(attr.name in attrs))
          toRemove.push(attr.name);
      }
      for (const attrName of toRemove)
        e.removeAttribute(attrName);
    }

    function isRef(s: NodeSnapshot): s is [Ref] {
      return typeof s !== 'string' && Array.isArray(s[0]);
    }

    function resolveRef(nodeId: NodeId, snapshotRef: Ref): NodeId {
      return [nodeId[0] - snapshotRef[0], snapshotRef[1]];
    }

    function resolveNodeSnapshot(nodeId: NodeId, s: NodeSnapshot): { s: Exclude<NodeSnapshot, [Ref]>, nodeId: NodeId } {
      if (!isRef(s))
        return { s, nodeId };
      const id = resolveRef(nodeId, s[0]);
      const snapshot = snapshots[id[0]];
      const nodes = snapshot ? snapshotNodes(snapshot) : [];
      if (id[1] >= 0 && id[1] < nodes.length)
        return { s: nodes[id[1]] as Exclude<NodeSnapshot, [Ref]>, nodeId: id };
      return { s: '', nodeId: id };
    }

    // |nodeId| is the id for this node. Updated in-place.
    function reconcile(n: Node, s: NodeSnapshot, nodeId: NodeId) {
      // if ('adoptedStyleSheets' in (root as any)) {
      //   const adoptedSheets: CSSStyleSheet[] = [...(root as any).adoptedStyleSheets];
      //   for (const element of root.querySelectorAll(`template[__playwright_style_sheet_]`)) {
      //     const template = element as HTMLTemplateElement;
      //     const sheet = new CSSStyleSheet();
      //     (sheet as any).replaceSync(template.getAttribute('__playwright_style_sheet_'));
      //     adoptedSheets.push(sheet);
      //   }
      //   (root as any).adoptedStyleSheets = adoptedSheets;
      // }

      if (typeof s === 'string') {
        (n as any)[idSymbol] = nodeId[0] + ':' + nodeId[1];
        // Best-effort Electron support: rewrite custom protocol in url() links in stylesheets.
        if (n.parentNode?.nodeName === 'STYLE')
          n.textContent = rewriteURLsInStyleSheetForCustomProtocol(s);
        else
          n.textContent = s;
        nodeId[1]++;
        return;
      }

      if (isRef(s)) {
        const id = resolveRef(nodeId, s[0]);
        const idString = id[0] + ':' + id[1];
        if ((n as any)[idSymbol] === idString)
          return;

        const resolved = resolveNodeSnapshot(nodeId, s);
        reconcile(n, resolved.s, resolved.nodeId);
        return;
      }

      (n as any)[idSymbol] = nodeId[0] + ':' + nodeId[1];
      nodeId[1]++;

      const isShadowRoot = n.nodeType === Node.DOCUMENT_FRAGMENT_NODE;
      const nodeName = isShadowRoot ? 'TEMPLATE' : n.nodeName;
      if (s[0].toUpperCase() !== nodeName)
        console.error('Unexpected nodeName for a node', n, s[0]);

      if (n.nodeType === Node.ELEMENT_NODE && s[1])
        reconcileAttributes(n as Element, s[1]);

      const sChildren = s.slice(2);
      if (!isShadowRoot && sChildren[0]) {
        // Is sChildren[0] a shadow root?
        const first = resolveNodeSnapshot(nodeId, sChildren[0]);
        if (Array.isArray(first.s) && first.s[0] === 'template' && first.s[1] && '__playwright_shadow_root_' in first.s[1]) {
          if (!(n as Element).shadowRoot)
            (n as Element).attachShadow({ mode: 'open' });
          reconcile((n as Element).shadowRoot!, sChildren[0], nodeId);
          sChildren.splice(0, 1);
        } else {
          // Note: we cannot remove shadow root, so leave an empty shadow root without slots
          // to avoid any side-effects.
          if ((n as Element).shadowRoot)
            (n as Element).shadowRoot!.textContent = '';
        }
      }

      const nChildren: Node[] = [...n.childNodes];
      const nChildById = new Map<string, Node>();
      for (const child of nChildren)
        nChildById.set((child as any)[idSymbol], child);
      const nToS = new Map<Node, NodeSnapshot>();
      const sToNMatch: (Node | undefined)[] = [];

      for (const sChild of sChildren) {
        let matchedChild: Node | undefined;
        if (typeof sChild === 'string') {
          for (const nChild of nChildren) {
            if (nChild.nodeType === Node.TEXT_NODE && !nToS.has(nChild) && nChild.nodeValue === sChild) {
              matchedChild = nChild;
              break;
            }
          }
        } else if (isRef(sChild)) {
          const resolvedId = resolveRef(nodeId, sChild[0]);
          const resolvedIdString = resolvedId[0] + ':' + resolvedId[1];
          for (const nChild of nChildren) {
            if (!nToS.has(nChild) && (nChild as any)[idSymbol] === resolvedIdString) {
              matchedChild = nChild;
              break;
            }
          }
        }
        sToNMatch.push(matchedChild);
        if (matchedChild)
          nToS.set(matchedChild, sChild);
      }

      let lastNChild: Node | undefined;
      for (let i = 0; i < sChildren.length; i++) {
        let matchedChild = sToNMatch[i];
        const resolved = resolveNodeSnapshot(nodeId, sChildren[i]);
        if (typeof resolved.s === 'string') {
          for (const nChild of nChildren) {
            if (matchedChild)
              break;
            if (nChild.nodeType === Node.TEXT_NODE && !nToS.has(nChild))
              matchedChild = nChild;
          }
          if (!matchedChild)
            matchedChild = document.createTextNode(resolved.s);
        } else {
          const sNodeName = resolved.s[0].toUpperCase();
          for (const nChild of nChildren) {
            if (matchedChild)
              break;
            if (nChild.nodeName === sNodeName && !nToS.has(nChild))
              matchedChild = nChild;
          }
          if (!matchedChild)
            matchedChild = document.createElement(sNodeName);
        }

        nToS.set(matchedChild, sChildren[i]);
        n.insertBefore(matchedChild, lastNChild ? lastNChild.nextSibling : n.firstChild);
        reconcile(matchedChild, sChildren[i], nodeId);
        lastNChild = matchedChild;
      }

      while (n.lastChild && n.lastChild !== lastNChild)
        n.lastChild.remove();
    }

    function getSnapshot(snapshotName: string): { html: NodeSnapshot, nodeId: NodeId, targetIds: (string | undefined)[] } {
      const snapshotIndex = snapshots.findIndex(s => s.snapshotName === snapshotName);
      if (snapshotIndex === -1)
        return { html: ['html'], nodeId: [snapshotIndex, 0], targetIds: [] };
      const snapshot = snapshots[snapshotIndex];
      // const prefix = snapshot.doctype ? `<!DOCTYPE ${snapshot.doctype}>` : '';
      return { html: snapshot.html, nodeId: [snapshotIndex, 0], targetIds: [snapshot.callId, snapshot.snapshotName] };
    }

    // <base>/snapshot.html?r=<snapshotUrl> is used for "pop out snapshot" feature.
    function unwrapPopoutUrl(url: string) {
      const u = new URL(url);
      if (u.pathname.endsWith('/snapshot.html'))
        return u.searchParams.get('r')!;
      return url;
    }

    function getURL() {
      return new URL(unwrapPopoutUrl(window.location.href));
    }

    function highlightTargetElements() {
      const hashParams = new URLSearchParams(getURL().hash.substring(1));
      if (hashParams.get('showPoint')) {
        for (const target of targetElements.keys()) {
          const pointElement = document.createElement('x-pw-pointer');
          pointElement.style.position = 'fixed';
          pointElement.style.backgroundColor = '#f44336';
          pointElement.style.width = '20px';
          pointElement.style.height = '20px';
          pointElement.style.borderRadius = '10px';
          pointElement.style.margin = '-10px 0 0 -10px';
          pointElement.style.zIndex = '2147483647';
          const box = target.getBoundingClientRect();
          pointElement.style.left = (box.left + box.width / 2) + 'px';
          pointElement.style.top = (box.top + box.height / 2) + 'px';
          document.documentElement.appendChild(pointElement);
        }
      }
    }

    function restoreScrollPositions() {
      // !!!!! This does not undo manual scrolling done on the snapshot.
      // Similar to highlighted targets?
      for (const [element, scrollTop] of scrollTops)
        element.scrollTop = scrollTop;
      for (const [element, scrollLeft] of scrollLefts)
        element.scrollLeft = scrollLeft;
    }

    function updateCustomElements() {
      const body = document.querySelector(`body[__playwright_custom_elements__]`);
      if (body && window.customElements) {
        const customElements = (body.getAttribute('__playwright_custom_elements__') || '').split(',');
        for (const elementName of customElements)
          window.customElements.define(elementName, class extends HTMLElement {});
      }
    }

    function onHashChange() {
      const hashParams = new URLSearchParams(getURL().hash.substring(1));
      renderSnapshot(hashParams.get('name') || '');
    }

    function onLoad() {
      window.removeEventListener('load', onLoad);
      restoreScrollPositions();
    }

    function renderSnapshot(snapshotName: string) {
      window.removeEventListener('load', onLoad);
      // window.removeEventListener('DOMContentLoaded', onDOMContentLoaded);
      // window.removeEventListener('hashchange', onHashChange);

      const snapshot = getSnapshot(snapshotName);
      targetIds = snapshot.targetIds;
      scrollLefts = new Map();
      scrollTops = new Map();
      targetElements = new Map();

      window.addEventListener('load', onLoad);
      reconcile(document.documentElement, snapshot.html, snapshot.nodeId);
      restoreScrollPositions();

      // window.addEventListener('DOMContentLoaded', onDOMContentLoaded);
      // window.addEventListener('hashchange', onHashChange);

      // document.open();
      // window.addEventListener('load', onLoad);
      // window.addEventListener('DOMContentLoaded', onDOMContentLoaded);
      // window.addEventListener('hashchange', onHashChange);
      // document.write(snapshot.html);
      // document.close();
    }

    window.addEventListener('hashchange', onHashChange);
    onHashChange();
  }
  return `\n(${loadSnapshots.toString()})()`;
}

/**
 * Best-effort Electron support: rewrite custom protocol in DOM.
 * vscode-file://vscode-app/ -> https://pw-vscode-file--vscode-app/
 */
const schemas = ['about:', 'blob:', 'data:', 'file:', 'ftp:', 'http:', 'https:', 'mailto:', 'sftp:', 'ws:', 'wss:'];
const kLegacyBlobPrefix = 'http://playwright.bloburl/#';

export function rewriteURLForCustomProtocol(href: string): string {
  // Legacy support, we used to prepend this to blobs, strip it away.
  if (href.startsWith(kLegacyBlobPrefix))
    href = href.substring(kLegacyBlobPrefix.length);

  try {
    const url = new URL(href);
    // Sanitize URL.
    if (url.protocol === 'javascript:' || url.protocol === 'vbscript:')
      return 'javascript:void(0)';

    // Pass through if possible.
    const isBlob = url.protocol === 'blob:';
    if (!isBlob && schemas.includes(url.protocol))
      return href;

    // Rewrite blob and custom schemas.
    const prefix = 'pw-' + url.protocol.slice(0, url.protocol.length - 1);
    url.protocol = 'https:';
    url.hostname = url.hostname ? `${prefix}--${url.hostname}` : prefix;
    return url.toString();
  } catch {
    return href;
  }
}

// <base>/snapshot.html?r=<snapshotUrl> is used for "pop out snapshot" feature.
export function unwrapPopoutUrl(url: string) {
  const u = new URL(url);
  if (u.pathname.endsWith('/snapshot.html'))
    return u.searchParams.get('r')!;
  return url;
}
