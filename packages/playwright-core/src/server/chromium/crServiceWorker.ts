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
import { Worker } from '../page';
import { CRBrowserContext } from './crBrowser';
import type { CRSession } from './crConnection';
import { CRExecutionContext } from './crExecutionContext';
import { CRNetworkManager } from './crNetworkManager';
import * as network from '../network';
import { BrowserContext } from '../browserContext';
import type { Protocol } from './protocol';
import type * as types from '../types';
import type * as channels from '@protocol/channels';
import { domainMatches } from '../cookieStore';

export class CRServiceWorker extends Worker {
  readonly _browserContext: CRBrowserContext;
  readonly _networkManager?: CRNetworkManager;
  private _session: CRSession;
  private _interceptorState: 'none' | 'waiting' | 'active' = 'none';

  constructor(browserContext: CRBrowserContext, session: CRSession, url: string) {
    super(browserContext, url);
    this._session = session;
    this._browserContext = browserContext;
    this._interceptorState = browserContext._expectedServiceWorkerInterceptorUrls.has(url) ? 'waiting' : 'none';
    browserContext._expectedServiceWorkerInterceptorUrls.delete(url);
    if (!!process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS || this._interceptorState === 'waiting')
      this._networkManager = new CRNetworkManager(null, this);
    session.once('Runtime.executionContextCreated', event => {
      this._createExecutionContext(new CRExecutionContext(session, event.context));
    });

    if (this._networkManager && this._isNetworkInspectionEnabled()) {
      this.updateRequestInterception();
      this.updateExtraHTTPHeaders();
      this.updateHttpCredentials();
      this.updateOffline();
      this._networkManager.addSession(session, undefined, true /* isMain */).catch(() => {});
    }

    session.send('Runtime.enable', {}).catch(e => { });
    if (this._interceptorState === 'waiting') {
      session.send('Runtime.addBinding', { name: 'sendMessageToPlaywright' }).catch(() => {});
      session.on('Runtime.bindingCalled', (event: Protocol.Runtime.bindingCalledPayload) => {
        try {
          const message = JSON.parse(event.payload) as InterceptorMessage;
          if (message.type === 'request')
            this._interceptRequest(message);
        } catch (e) {
          this._dispatchMessageToInterceptor({ type: 'error', error: String(e) });
        }
      });
    }

    session.send('Runtime.runIfWaitingForDebugger').catch(e => { });
    session.on('Inspector.targetReloadedAfterCrash', () => {
      // Resume service worker after restart.
      session._sendMayFail('Runtime.runIfWaitingForDebugger', {});
    });

    if (this._interceptorState === 'none')
      browserContext.emit(CRBrowserContext.CREvents.ServiceWorker, this);
  }

  override didClose() {
    this._networkManager?.removeSession(this._session);
    this._session.dispose();
    super.didClose();
  }

  async updateOffline(): Promise<void> {
    if (!this._isNetworkInspectionEnabled())
      return;
    await this._networkManager?.setOffline(!!this._browserContext._options.offline).catch(() => {});
  }

  async updateHttpCredentials(): Promise<void> {
    if (!this._isNetworkInspectionEnabled())
      return;
    await this._networkManager?.authenticate(this._browserContext._options.httpCredentials || null).catch(() => {});
  }

  async updateExtraHTTPHeaders(): Promise<void> {
    if (!this._isNetworkInspectionEnabled())
      return;
    await this._networkManager?.setExtraHTTPHeaders(this._browserContext._options.extraHTTPHeaders || []).catch(() => {});
  }

  async updateRequestInterception(): Promise<void> {
    if (!this._isNetworkInspectionEnabled())
      return;
    await this._networkManager?.setRequestInterception(this.needsRequestInterception()).catch(() => {});
  }

  needsRequestInterception(): boolean {
    return this._isNetworkInspectionEnabled() && (this._interceptorState === 'waiting' || !!this._browserContext._requestInterceptor);
  }

  reportRequestFinished(request: network.Request, response: network.Response | null) {
    if (this._interceptorState === 'none')
      this._browserContext.emit(BrowserContext.Events.RequestFinished, { request, response });
  }

  requestFailed(request: network.Request, _canceled: boolean) {
    if (this._interceptorState === 'none')
      this._browserContext.emit(BrowserContext.Events.RequestFailed, request);
  }

  requestReceivedResponse(response: network.Response) {
    if (this._interceptorState === 'none')
      this._browserContext.emit(BrowserContext.Events.Response, response);
  }

  requestStarted(request: network.Request, route?: network.RouteDelegate) {
    if (this._interceptorState === 'none')
      this._browserContext.emit(BrowserContext.Events.Request, request);
    if (route) {
      const r = new network.Route(request, route);
      if (this._interceptorState === 'waiting') {
        console.log(`fulfilling service worker`, request.url());
        r.fulfill({ body: `(${swInterceptionScript})()`, headers: [{ name: 'content-type', value: 'application/javascript' }], requestUrl: request.url() }).catch(() => {}).then(() => {
          this._interceptorState = 'active';
          this.updateRequestInterception();
        });
        return;
      }
      if (this._interceptorState === 'none' && this._browserContext._requestInterceptor?.(r, request))
        return;
      r.continue({ isFallback: true }).catch(() => {});
    }
  }

  private _isNetworkInspectionEnabled(): boolean {
    return this._browserContext._options.serviceWorkers !== 'block';
  }

  private async _interceptRequest(message: InterceptorRequestMessage) {
    console.log(`node intercept request`, message);
    try {
      const cookies = await this._browserContext.cookies(message.url);
      if (cookies.length) {
        const valueArray = cookies.map(c => `${c.name}=${c.value}`);
        message.headers.push({ name: 'cookie', value: valueArray.join('; ') });
      }
    } catch {
      console.log(`node ignoring a request because cannot fetch cookies`);
      this._dispatchMessageToInterceptor({ type: 'response', id: message.id, action: { type: 'continue' }});
      return;
    }

    const request = new network.Request(
        // TODO: isNavigationRequest()
        this._browserContext, null, this, null, undefined, message.url,
        requestDestinationToResourceType(message.destination), message.method,
        message.bodyBase64.length ? Buffer.from(message.bodyBase64, 'base64') : null,
        message.headers);
    request.setRawRequestHeaders(null);
    const route = new network.Route(request, {
      abort: async (errorCode: string) => {
        this._dispatchMessageToInterceptor({ type: 'response', id: message.id, action: { type: 'abort' }});
      },
      fulfill: async (response: types.NormalizedFulfillResponse) => {
        try {
          const setCookies = response.headers.filter(h => h.name.toLowerCase() === 'set-cookie').map(h => h.value.split('\n')).flat();
          const cookies = parseSetCookieHeader(message.url, setCookies);
          if (cookies.length) {
            try {
              await this._browserContext.addCookies(cookies);
            } catch (e) {
              // Cookie value is limited by 4096 characters in the browsers. If setCookies failed,
              // we try setting each cookie individually just in case only some of them are bad.
              await Promise.all(cookies.map(c => this._browserContext.addCookies([c]).catch(() => {})));
            }
          }
        } catch {
          console.log(`node ignoring bad Set-Cookie headers`);
        }

        this._dispatchMessageToInterceptor({ type: 'response', id: message.id, action: {
          type: 'fulfill',
          status: response.status,
          headers: response.headers.filter(h => h.name.toLowerCase() !== 'set-cookie'),
          bodyBase64: response.isBase64 ? response.body : Buffer.from(response.body, 'utf8').toString('base64'),
        }});
      },
      continue: async (request: network.Request, overrides: types.NormalizedContinueOverrides) => {
        this._dispatchMessageToInterceptor({ type: 'response', id: message.id, action: {
          type: 'continue',
          url: overrides.url,
          method: overrides.method,
          headers: overrides.headers,
          bodyBase64: overrides.postData?.toString('base64'),
        }});
      },
    });
    for (const page of this._browserContext.pages()) {
      console.log('page has client: ', !!page._clientRequestInterceptor);
      if (page._serverRequestInterceptor?.(route, request))
        return;
      if (page._clientRequestInterceptor?.(route, request))
        return;
    }
    console.log('no page did intercept');
    if (this._browserContext._requestInterceptor?.(route, request))
      return;
    route.continue({ isFallback: true }).catch(() => {});
  }

  private _dispatchMessageToInterceptor(message: InterceptorMessage) {
    this._session.send('Runtime.evaluate', { expression: `self.dispatchMessageFromPlaywright(${JSON.stringify(message)})`, returnByValue: true }).catch(() => {});
  }
}

function requestDestinationToResourceType(destination: string): string {
  switch (destination) {
    case 'audio': return 'media';
    case 'audioworklet': return 'script';
    case 'document': return 'document';
    case 'embed': return 'document';
    case 'font': return 'font';
    case 'frame': return 'document';
    case 'iframe': return 'document';
    case 'image': return 'image';
    case 'manifest': return 'manifest';
    case 'object': return 'document';
    case 'paintworklet': return 'script';
    case 'report': return 'other';
    case 'script': return 'script';
    case 'sharedworker': return 'script';
    case 'style': return 'stylesheet';
    case 'track': return 'texttrack';
    case 'video': return 'media';
    case 'worker': return 'script';
    case 'xslt': return 'other';
  }
  return 'other';
}

function parseSetCookieHeader(responseUrl: string, setCookie: string[] | undefined): channels.NetworkCookie[] {
  if (!setCookie)
    return [];
  const url = new URL(responseUrl);
  // https://datatracker.ietf.org/doc/html/rfc6265#section-5.1.4
  const defaultPath = '/' + url.pathname.substr(1).split('/').slice(0, -1).join('/');
  const cookies: channels.NetworkCookie[] = [];
  for (const header of setCookie) {
    // Decode cookie value?
    const cookie: channels.NetworkCookie | null = parseCookie(header);
    if (!cookie)
      continue;
    // https://datatracker.ietf.org/doc/html/rfc6265#section-5.2.3
    if (!cookie.domain)
      cookie.domain = url.hostname;
    else if (!cookie.domain.startsWith('.') && cookie.domain.includes('.'))
      throw new Error(`Unexpected cookie domain "${cookie.domain}"`);
    if (!domainMatches(url.hostname, cookie.domain!))
      continue;
    // https://datatracker.ietf.org/doc/html/rfc6265#section-5.2.4
    if (!cookie.path || !cookie.path.startsWith('/'))
      cookie.path = defaultPath;
    cookies.push(cookie);
  }
  return cookies;
}

function parseCookie(header: string): channels.NetworkCookie | null {
  const pairs = header.split(';').filter(s => s.trim().length > 0).map(p => {
    let key = '';
    let value = '';
    const separatorPos = p.indexOf('=');
    if (separatorPos === -1) {
      // If only a key is specified, the value is left undefined.
      key = p.trim();
    } else {
      // Otherwise we assume that the key is the element before the first `=`
      key = p.slice(0, separatorPos).trim();
      // And the value is the rest of the string.
      value = p.slice(separatorPos + 1).trim();
    }
    return [key, value];
  });
  if (!pairs.length)
    return null;
  const [name, value] = pairs[0];
  const cookie: channels.NetworkCookie = {
    name,
    value,
    domain: '',
    path: '',
    expires: -1,
    httpOnly: false,
    secure: false,
    // From https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie/SameSite
    // The cookie-sending behavior if SameSite is not specified is SameSite=Lax.
    sameSite: 'Lax'
  };
  for (let i = 1; i < pairs.length; i++) {
    const [name, value] = pairs[i];
    switch (name.toLowerCase()) {
      case 'expires':
        const expiresMs = (+new Date(value));
        // https://datatracker.ietf.org/doc/html/rfc6265#section-5.2.1
        if (isFinite(expiresMs)) {
          if (expiresMs <= 0)
            cookie.expires = 0;
          else
            cookie.expires = Math.min(expiresMs / 1000, network.kMaxCookieExpiresDateInSeconds);
        }
        break;
      case 'max-age':
        const maxAgeSec = parseInt(value, 10);
        if (isFinite(maxAgeSec)) {
          // From https://datatracker.ietf.org/doc/html/rfc6265#section-5.2.2
          // If delta-seconds is less than or equal to zero (0), let expiry-time
          // be the earliest representable date and time.
          if (maxAgeSec <= 0)
            cookie.expires = 0;
          else
            cookie.expires = Math.min(Date.now() / 1000 + maxAgeSec, network.kMaxCookieExpiresDateInSeconds);
        }
        break;
      case 'domain':
        cookie.domain = value.toLocaleLowerCase() || '';
        if (cookie.domain && !cookie.domain.startsWith('.') && cookie.domain.includes('.'))
          cookie.domain = '.' + cookie.domain;
        break;
      case 'path':
        cookie.path = value || '';
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite':
        switch (value.toLowerCase()) {
          case 'none':
            cookie.sameSite = 'None';
            break;
          case 'lax':
            cookie.sameSite = 'Lax';
            break;
          case 'strict':
            cookie.sameSite = 'Strict';
            break;
        }
        break;
    }
  }
  return cookie;
}

type InterceptorRequestMessage = { type: 'request', id: string, url: string, method: string, bodyBase64: string, headers: types.HeadersArray, mode: 'cors' | 'navigate' | 'no-cors' | 'same-origin', destination: string };
type InterceptorResponseMessage = { type: 'response', id: string,
  action:
      { type: 'abort' } |
      { type: 'fulfill', bodyBase64: string, status: number, headers: types.HeadersArray } |
      { type: 'continue', url?: string, method?: string, headers?: types.HeadersArray, bodyBase64?: string },
};
type InterceptorErrorMessage = { type: 'error', error: string };
type InterceptorMessage = InterceptorErrorMessage | InterceptorRequestMessage | InterceptorResponseMessage;

function swInterceptionScript() {
  // @ts-ignore
  declare const self: ServiceWorkerGlobalScope;

  let lastRequestId = 0;
  const responseCallbacks = new Map<string, (message: InterceptorResponseMessage) => void>();

  function toHeaders(headersArray: types.HeadersArray | undefined, removeReferer?: 'remove-referer'): Headers | undefined {
    if (!headersArray)
      return;
    const headers = new Headers();
    for (const { name, value } of headersArray) {
      if (name.toLowerCase() === 'referer' && removeReferer)
        continue;
      headers.append(name, value);
    }
    return headers;
  }

  function extractReferer(headers: types.HeadersArray | undefined) {
    const header = headers?.find(h => h.name.toLowerCase() === 'referer');
    return header?.value;
  }

  const doFetch = async (event: any): Promise<Response> => {
    console.log('SW fetch2');

    const request: Request = event.request;
    const bodyReader = new FileReader();
    const bodyPromise = new Promise<string>(f => {
      bodyReader.onload = () => f((bodyReader.result as string).split(',')[1]);
    })
    bodyReader.readAsDataURL(await request.clone().blob());
    const id = String(++lastRequestId);
    const requestMessage: InterceptorRequestMessage = {
      type: 'request',
      id,
      url: request.url,
      method: request.method,
      headers: [...request.headers.entries()].map(e => ({ name: e[0], value: e[1] })).concat([{ name: 'Referer', value: request.referrer }]),
      bodyBase64: await bodyPromise,
      mode: request.mode,
      destination: request.destination,
    };
    const responseMessage = await new Promise<InterceptorResponseMessage>(f => {
      responseCallbacks.set(id, f);
      console.log('sendMessageToPlaywright', requestMessage);
      self.sendMessageToPlaywright(JSON.stringify(requestMessage));
    });
    console.log('SW got response', responseMessage);

    const action = responseMessage.action;

    if (action.type === 'fulfill') {
      const body = action.bodyBase64.length ? atob(action.bodyBase64) : undefined;
      console.log('fulfilling in SW', action.status, action.headers, body);
      return new Response(body, {
        status: action.status,
        headers: toHeaders(action.headers),
      });
    }

    if (action.type === 'abort') {
      const abortController = new AbortController();
      const responsePromise = fetch('http://some.unknown.host.playwright', { signal: abortController.signal });
      abortController.abort();
      return responsePromise;
    }

    if (action.type === 'continue') {
      console.log('SW got body', action);
      let body: Blob | undefined;
      if (action.bodyBase64) {
        const bytes = atob(action.bodyBase64);
        const byteArray = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++)
          byteArray[i] = bytes.charCodeAt(i);
        body = new Blob([byteArray]);
      }
      let newRequest;
      if (action.url) {
        newRequest = new Request(action.url, {
          body,
          // browsingTopics: browsingTopics,
          cache: request.cache,
          credentials: request.credentials,
          headers: toHeaders(action.headers, 'remove-referer'),
          integrity: request.integrity,
          keepalive: request.keepalive,
          method: action.method || request.method,
          // TODO: Cannot construct a Request with a RequestInit whose mode member is set as 'navigate'
          mode: request.mode === 'navigate' ? 'same-origin' : request.mode,
          // priority: request.priority,
          redirect: request.redirect,
          referrer: extractReferer(action.headers) || request.referrer,
          referrerPolicy: request.referrerPolicy,
          signal: request.signal,
        })
      } else {
        newRequest = new Request(request.clone(), {
          body,
          method: action.method,
          headers: toHeaders(action.headers, 'remove-referer'),
          referrer: extractReferer(action.headers),
        });
      }
      console.log(`SW continue, request.referrer=${request.referrer}, extracted=${extractReferer(action.headers)}, newref=${newRequest.referrer}`);
      return fetch(newRequest);
    }

    throw new Error(`Unknown action ${(action as any).type}`);
  };

  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event: any) => event.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', (event: any) => {
    console.log('SW fetch1');
    // DevTools reloads some resources.
    if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin')
      return;
    console.log('SW fetch2');
    // Some requests are from unknown origin, ignore them.
    // if (!event.clientId)
    //   return;
    console.log('SW fetch3');
    event.respondWith(doFetch(event));
  });

  self.dispatchMessageFromPlaywright = (message: InterceptorMessage) => {
    console.log('dispatchMessageFromPlaywright2 ' + JSON.stringify(message));
    if (message.type === 'response') {
      const cb = responseCallbacks.get(message.id);
      console.log('dispatchMessageFromPlaywright3', cb);
      responseCallbacks.delete(message.id);
      cb?.(message);
    }
  };

  console.log('SW setup');
}
