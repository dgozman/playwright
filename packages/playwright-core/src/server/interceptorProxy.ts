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

import http from 'http';
import https from 'https';
import net from 'net';
import url from 'url';
import crypto from 'crypto';
import stream from 'stream';
import { ManualPromise, createHttpServer, createHttpsServer } from '../utils';
import * as network from './network';
import type { Browser } from './browser';
import { HeadersArray } from '../common/types';
import { NormalizedContinueOverrides, NormalizedFulfillResponse, ProxySettings } from './types';
import { debugLogger } from '../utils/debugLogger';
import type { Protocol } from './chromium/protocol';
import type { CRBrowserContext } from './chromium/crBrowser';
import type { BrowserContext } from './browserContext';
import { HttpsProxyAgent, HttpProxyAgent, SocksProxyAgent, type NodeForge, nodeForge } from '../utilsBundle';
import { httpHappyEyeballsAgent, httpsHappyEyeballsAgent } from '../utils/happy-eyeballs';

export class InterceptorProxy {
  private _server: http.Server;
  private _browserProxySettings: ProxySettings | undefined;
  private _serverPort!: number;
  browser: Browser | undefined;
  requestById = new Map<string, InterceptedRequest>();
  private _ca!: CA;
  private _httpsServers = new Map<string, Promise<{ port: number, server: http.Server }>>();

  constructor() {
    this._server = createHttpServer();
    this._server.on('request', (req, res) => this._onRequest(req, res, ''));
    this._server.on('connection', socket => this._onSocket(socket));
    this._server.on('connect', (req, socket, head) => this._onConnect(req, socket, head));
    // TODO: UPGRADE
  }

  async start() {
    this._ca = await generateCA();
    this._server.listen();
    await new Promise(f => this._server.once('listening', f));
    const address = this._server.address() as net.AddressInfo;
    this._serverPort = address.port;
    const server = `http://localhost:${address.port}`;
    debugLogger.log('socks', `interception proxy listening at ${server}`);
    // TODO: perhaps use guid username/password so that only our browser can access this proxy?
    this._browserProxySettings = { server };
  }

  async stop() {
    debugLogger.log('socks', `stopping: waiting for https servers`);
    const httpsServers = await Promise.all([...this._httpsServers.values()]);
    const servers = [this._server, ...httpsServers.map(s => s.server)];
    debugLogger.log('socks', `stopping: closing all servers`);
    await Promise.all(servers.map(server => new Promise(f => server.close(f))));
    debugLogger.log('socks', `stopping: finished`);
  }

  proxySettings() {
    return this._browserProxySettings;
  }

  spki() {
    return this._ca.spki;
  }

  matchByRequestId(context: BrowserContext, requestId: string) {
    const request = this.requestById.get(requestId);
    if (request)
      return request.matched(context);
  }

  private _onSocket(socket: stream.Duplex) {
    // ECONNRESET and HPE_INVALID_EOF_STATE are legit errors given
    // that tab closing aborts outgoing connections to the server.
    // HPE_INVALID_METHOD is a legit error when a client (e.g. Chromium which
    // makes https requests to http sites) makes a https connection to a http server.
    // socket.on('error', error => {
    //   if (!['ECONNRESET', 'HPE_INVALID_EOF_STATE', 'HPE_INVALID_METHOD'].includes((error as any).code))
    //     throw error;
    // });
  }

  private async _onRequest(req: http.IncomingMessage, res: http.ServerResponse, urlPrefix: string) {
    try {
      req.url = urlPrefix + (req.url || '');
      await new InterceptedRequest(req, res, this).handle();
    } catch (error) {
      debugLogger.log('socks', `error handling ${req.method} ${req.url}: ${error.stack || error.message}`);
      res.writeHead(500);
      res.end((error.stack || error.message || error) + '\n');
    }
  }

  private async _onConnect(req: http.IncomingMessage, socket: stream.Duplex, head: Buffer) {
    const id = 'c' + (++lastRequestId);
    debugLogger.log('socks', `[${id}] connect ${req.url}`);
    const parsedUrl = url.parse(`https://${req.url}`);
    const hostname = parsedUrl.hostname;
    if (!hostname) {
      debugLogger.log('socks', `[${id}] connect ${req.url}: invalid hostname - destroying`);
      socket.destroy();
      return;
    }

    socket.on('error', error => {
      debugLogger.log('socks', `[${id}] connect ${req.url}: client error ${error.stack || error.message}`);
    });

    debugLogger.log('socks', `[${id}] connect ${req.url}: accepting`);
    socket.write('HTTP/1.1 200 OK\r\n');
    if (req.headers['proxy-connection'] === 'keep-alive') {
      socket.write('Proxy-Connection: keep-alive\r\n');
      socket.write('Connection: keep-alive\r\n');
    }
    socket.write('\r\n');

    if (!head || !head.length) {
      await new Promise<void>(f => socket.once('data', buffer => {
        head = buffer;
        socket.pause();
        f();
      }));
    } else {
      socket.pause();
    }

    let serverPort = this._serverPort;

    // Determine whether data is encrypted to know whether we need an https server.
    // - 0x16 is SSLv3/TLS "handshake" content type: https://en.wikipedia.org/wiki/Transport_Layer_Security#TLS_record
    // - 0x00/0x80 is SSLv2 "record size" and possibly a flag in the first bit.
    if (head[0] === 0x16 || head[0] === 0x00 || head[0] === 0x80) {
      debugLogger.log('socks', `[${id}] connect ${req.url}: secure connection, waiting for https server`);
      const origin = `https://${hostname}${parsedUrl.port && parsedUrl.port !== '443' ? ':' + parsedUrl.port : ''}`;
      let serverPromise = this._httpsServers.get(origin);
      if (!serverPromise) {
        serverPromise = this._startHttpsServer(hostname, origin);
        this._httpsServers.set(origin, serverPromise);
      }
      serverPort = (await serverPromise).port;
    }

    debugLogger.log('socks', `[${id}] connect ${req.url}: forwarding to 0.0.0.0:${serverPort}`);
    const targetSocket = net.connect({ host: '0.0.0.0', port: serverPort, allowHalfOpen: true });
    let connected = false;
    targetSocket.on('close', () => {
      debugLogger.log('socks', `[${id}] connect ${req.url}: target socket closed`);
      socket.destroy();
    });
    socket.on('close', () => {
      debugLogger.log('socks', `[${id}] connect ${req.url}: client socket closed`);
      targetSocket.destroy();
    });
    targetSocket.on('error', error => {
      debugLogger.log('socks', `[${id}] connect ${req.url}: connection error ${error}`);
      if (connected) {
        targetSocket.destroy();
        socket.destroy();
      } else {
        // TODO: respond with a proper error. However, we have already responded with 200 OK,
        // so just destroy for now.
        targetSocket.destroy();
        socket.destroy();
      }
    });
    targetSocket.on('connect', () => {
      debugLogger.log('socks', `[${id}] connect ${req.url}: pipe started`);
      connected = true;
      socket.pipe(targetSocket);
      targetSocket.pipe(socket);
      // Re-emit head so it gets into targetSocket.
      socket.emit('data', head);
      socket.resume();
    });
  }

  private async _startHttpsServer(hostname: string, origin: string) {
    debugLogger.log('socks', `https server for ${hostname}: generating certificates`);
    const cert = await generateServerCertificate(this._ca, [hostname]);
    // TODO: use https://nodejs.org/api/http2.html#compatibility-api to support HTTP/2
    // Note that we cannot call socket.pause() in this case.
    const server = createHttpsServer({ cert: cert.certPem, key: cert.keyPem });
    server.on('request', (req, res) => this._onRequest(req, res, origin));
    server.on('connection', socket => this._onSocket(socket));
    server.listen();
    await new Promise(f => server.once('listening', f));
    const port = (server.address() as net.AddressInfo).port;
    debugLogger.log('socks', `https server for ${hostname}: listening at 0.0.0.0:${port}`);
    return { server, port };
  }
}

let lastRequestId = 0;

class InterceptedRequest implements network.RouteDelegate {
  private _req: http.IncomingMessage;
  private _res: http.ServerResponse;
  private _requestId: string = '';
  private _reqHeaders: HeadersArray;
  private _reqCorsFilteredHeaders: string[] = [];
  private _body: Buffer;
  private _proxy: InterceptorProxy;
  private _proxySettings: ProxySettings | undefined;
  private _ignoreHTTPSErrors: boolean | undefined;
  private _finishedPromise = new ManualPromise<void>();
  private _targetReq: http.ClientRequest | undefined;
  private _log: (message: string) => void;
  readonly requestPausedEvent: Protocol.Fetch.requestPausedPayload;

  constructor(req: http.IncomingMessage, res: http.ServerResponse, proxy: InterceptorProxy) {
    const requestId = 'r' + (++lastRequestId);
    this._log = s => debugLogger.log('socks', `[${requestId}] ${s}`);
    this._req = req;
    this._res = res;
    this._body = Buffer.from([]);
    this._reqHeaders = rawHeadersToHeadersArray(req.rawHeaders);
    this._proxy = proxy;
    this.requestPausedEvent = {
      requestId: '',
      request: { url: '', method: '', headers: {}, initialPriority: 'Medium', referrerPolicy: 'no-referrer' },
      frameId: '',
      resourceType: 'Other',
    };
    req.on('error', error => {
      this._log(`client request error ${error.stack || error.message}`);
      this._cleanup();
    });
    req.on('close', () => {
      this._log(`client request finished, response continues`);
    });
    res.on('finish', () => {
      this._log(`client response finished`);
      this._cleanup();
    });
    res.on('close', () => {
      if (!this._finishedPromise.isDone())
        this._log(`client response disconnected prematurely`);
      this._cleanup();
    });
    res.on('error', error => {
      this._log(`client response error ${(error as any).code} ${error.stack || error.message}`);
      this._cleanup();
    });
    this._log(`${req.method} ${req.url}`);
  }

  // private _findMatchingRequest(attribution: string) {
  //   for (const context of this._proxy.browser?.contexts() || []) {
  //     for (const page of context.pages()) {
  //       if (page.guid !== attribution || !page.needsRequestInterception())
  //         continue;

  //       for (const frame of page.frames()) {
  //         for (const request of frame._inflightRequests) {
  //           if (request._frame === frame && request.url() === this._req.url && request.method() === this._req.method)
  //             return { frame, request };
  //         }
  //       }
  //       return { frame: page.mainFrame() };
  //     }
  //   }
  // }

  async handle() {
    const requestUrl = this._req.url ?? '';
  	const parsedUrl = url.parse(requestUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      this._log(`unsupported protocol "${parsedUrl.protocol}"`);
      this._res.writeHead(400);
      this._res.end(`Unsupported protocol "${parsedUrl.protocol}"`);
      return this._cleanup();
    }

    {
      let requestId = this._req.headers[kRequestIdHeader];
      if (Array.isArray(requestId))
        requestId = requestId[0];
      this._requestId = requestId || '';
    }
    this._log(`requestId="${this._requestId}"`);

    const bodyError = await this._readBody();
    if (bodyError) {
      this._log(`error reading body "${bodyError.stack || bodyError.message}"`);
      this._res.writeHead(400);
      this._res.end((bodyError.stack || bodyError.message) + '\n');
      return this._cleanup();
    }

    // This is a heuristic to detect OPTIONS preflight for CORS vs explicit OPTIONS fetch().
    if (this._req.method === 'OPTIONS' &&
        this._req.headers['access-control-request-method'] &&
        (this._req.headers['access-control-request-headers'] || '').split(',').some(h => h.trim() === kInterceptingHeaderForCorsPreflight)) {
      this._log(`stubbing cors options preflight`);
      const headers: HeadersArray = [
        { name: 'access-control-allow-origin', value: this._req.headers['origin'] || '*' },
        { name: 'access-control-allow-methods', value: this._req.headers['access-control-request-method'] },
        { name: 'access-control-allow-credentials', value: 'true' },
        { name: 'access-control-allow-headers', value: this._req.headers['access-control-request-headers']! },
      ];
      return this.fulfill({
        status: 204,
        headers,
        body: '',
        isBase64: false,
      });
    }

    const filtered = filterHeaders(this._reqHeaders, h => !kHeadersToRemoveImmediately.has(h));
    this._reqCorsFilteredHeaders = filtered.removedCorsHeaders;
    this._reqHeaders = filtered.headers;

    // TODO: instead of relying on filterHeaders, merge this with the cors options preflight check above.
    if (filtered.unnecessaryCorsPreflight && this._req.headers['access-control-request-method'] === 'GET') {
      this._log(`stubbing cors options preflight because it was only needed for our instrumentation`);
      const headers: HeadersArray = [
        { name: 'access-control-allow-origin', value: this._req.headers['origin'] || '*' },
        { name: 'access-control-allow-methods', value: this._req.headers['access-control-request-method'] || 'GET' },
        { name: 'access-control-allow-credentials', value: 'true' },
        { name: 'access-control-allow-headers', value: this._req.headers['access-control-request-headers']! },
      ];
      return this.fulfill({
        status: 204,
        headers,
        body: '',
        isBase64: false,
      });
    }

    if (this._requestId)
      this._proxy.requestById.set(this._requestId, this);
    this.requestPausedEvent.networkId = this._requestId;
    this.requestPausedEvent.request.url = requestUrl;
    this.requestPausedEvent.request.method = this._req.method || 'GET';
    this.requestPausedEvent.request.headers = headersArrayToHeadersObject(this._reqHeaders);
    if (this._body.byteLength) {
      this.requestPausedEvent.request.hasPostData = true;
      this.requestPausedEvent.request.postDataEntries = [{ bytes: this._body.toString('base64') }];
    }

    const contexts = this._proxy.browser?.contexts() || [];
    if (this._proxy.browser?._defaultContext)
      contexts.push(this._proxy.browser?._defaultContext);
    for (const context of contexts) {
      for (const page of (context as CRBrowserContext)._crPages()) {
        if (page._networkManager.willHandleRequestPausedFromInterceptorProxy(this._requestId)) {
          page._networkManager.handleRequestPausedFromInterceptorProxy(this.matched(page._browserContext));
          return;
        }
      }
    }

    if (!this._requestId) {
      // This covers all uninstrumented requests:
      // - service worker requests;
      // - any browser-initiated requests not related to the page;
      // - OPTIONS preflight while not intercepting.
      this.continue({ isFallback: true });
    }
  }

  private async _readBody() {
    const bodyPromise = new ManualPromise<Error | undefined>();
    const onError = (error: Error) => bodyPromise.resolve(error);
    const onClose = () => bodyPromise.resolve(new Error('Closed unexpectedly'));
    const buffers: Buffer[] = [];
    this._req.on('data', chunk => buffers.push(Buffer.from(chunk)));
    this._req.on('error', onError);
    this._req.on('close', onClose);
    this._req.on('end', () => {
      this._body = Buffer.concat(buffers);
      bodyPromise.resolve(undefined);
    });
    const bodyResult = await bodyPromise;
    this._req.off('error', onError);
    this._req.off('close', onClose);
    return bodyResult;
  }

  matched(context: BrowserContext) {
    this._proxySettings = context._options.proxy || this._proxy.browser?.options.proxy;
    this._ignoreHTTPSErrors = context._options.ignoreHTTPSErrors;
    this._log(`found a matching request, routing`);
    return { requestPausedEvent: this.requestPausedEvent, routeDelegate: this };
  }

  async abort(errorCode: string) {
    if (this._finishedPromise.isDone())
      return;
    // TODO: errorCode?
    this._log(`aborting with ${errorCode}`);
    this._cleanup();
  }

  async fulfill(response: NormalizedFulfillResponse) {
    const statusMessage = network.STATUS_TEXTS[response.status];
    if (!statusMessage)
      throw new Error(`Invalid http status code or phrase ${response.status}`);
    const body = Buffer.from(response.body, response.isBase64 ? 'base64' : undefined);

    if (this._finishedPromise.isDone())
      return;
    this._log(`fulfilling with ${response.status} ${statusMessage} ${body.toString('utf-8')}`);
    // TODO: restore cors headers similar to continue
    // TODO: keep "content-encoding" header and encode response body here
    const headers = headersArrayToHttpOugoingHeaders(filterHeaders(splitSetCookieHeader(response.headers), h => h !== 'content-encoding').headers);
    this._res.removeHeader('connection');
    this._res.removeHeader('transfer-encoding');
    this._res.removeHeader('date');
    if (body.byteLength)
      headers['content-length'] = body.byteLength;
    else
      delete headers['content-length'];
    this._res.writeHead(response.status, statusMessage, headers);
    this._res.end(body);
  }

  async continue(overrides: NormalizedContinueOverrides) {
    if (this._finishedPromise.isDone())
      return;

    this._log(`continuing to ${overrides.url ?? this._req.url}`);
  	const parsedUrl = url.parse(overrides.url ?? this._req.url ?? '');
    // TODO: remove headers specified by "Connection" header?
    let headers = overrides.headers ? splitSetCookieHeader(overrides.headers) : filterHeaders(this._reqHeaders, h => !kHeadersToRemoveWhenProxying.has(h)).headers;
    if (overrides.postData)
      headers = filterHeaders(headers, h => h !== 'content-length').headers;

    const proxy = this._proxySettings;
    let agent: http.Agent = parsedUrl.protocol === 'https:' ? httpsHappyEyeballsAgent : httpHappyEyeballsAgent;
    if (proxy && proxy.server !== 'per-context' && !shouldBypassProxy(parsedUrl.hostname!, proxy.bypass)) {
      const proxyOpts = url.parse(proxy.server);
      if (proxyOpts.protocol?.startsWith('socks')) {
        agent = new SocksProxyAgent({
          host: proxyOpts.hostname,
          port: proxyOpts.port || undefined,
        });
      } else {
        if (proxy.username)
          proxyOpts.auth = `${proxy.username}:${proxy.password || ''}`;
        agent = parsedUrl.protocol === 'https:' ? new HttpsProxyAgent(proxyOpts) : new HttpProxyAgent(proxyOpts);
      }
    }

    const requestOptions = {
      ...parsedUrl,
      agent,
      method: overrides.method ?? this._req.method,
      headers: headersArrayToHttpOugoingHeaders(headers),
      rejectUnauthorized: !this._ignoreHTTPSErrors,
    };
    const targetReq = (parsedUrl.protocol === 'https:' ? https : http).request(requestOptions);
    this._targetReq = targetReq;

    let receivedResponse = false;
    targetReq.on('error', (error: Error) => {
      this._log(`target request error ${(error as any).code} ${error.stack || error.message}`);
      if (!receivedResponse) {
        // Respond with a best-effort error.
        if ('ECONNRESET' === (error as any).code) {
          this._res.socket?.destroy();
        } else if ('ENOTFOUND' === (error as any).code) {
          this._res.writeHead(404);
          this._res.end();
        } else {
          this._res.writeHead(500);
          this._res.end();
        }
      }
      this._cleanup();
    });

    targetReq.on('response', targetRes => {
      this._log(`target response received ${targetRes.statusCode} ${targetRes.statusMessage}`);
      receivedResponse = true;
      let headers = rawHeadersToHeadersArray(targetRes.rawHeaders);
      headers = filterHeaders(headers, h => !kHeadersToRemoveWhenProxying.has(h), this._reqCorsFilteredHeaders).headers;
      // TODO: remove headers specified by "Connection" header?
      this._res.writeHead(targetRes.statusCode || 0, targetRes.statusMessage, headersArrayToHttpOugoingHeaders(headers));
      targetRes.on('error', error => {
        this._log(`target response error ${error.stack || error.message}`);
        this._cleanup();
      });
      targetRes.on('aborted', () => {
        this._log(`target response aborted`);
        this._cleanup();
      });
      targetRes.pipe(this._res);
    });

    targetReq.end(overrides.postData ?? this._body);
  }

  private _cleanup() {
    if (this._finishedPromise.isDone())
      return;
    this._log(`cleanup`);
    this._req.socket.destroy();
    this._res.socket?.destroy();
    this._targetReq?.destroy();
    this._finishedPromise.resolve();
    if (this._requestId)
      this._proxy.requestById.delete(this._requestId);
  }
}

function headersArrayToHttpOugoingHeaders(headers: HeadersArray) {
  const result: http.OutgoingHttpHeaders = {};
  for (const { name, value } of headers) {
    let values = result[name];
    if (values === undefined) {
      result[name] = value;
    } else {
      if (!Array.isArray(values))
        values = [String(values)];
      values.push(value);
      result[name] = values;
    }
  }
  return result;
}

function headersArrayToHeadersObject(headers: HeadersArray) {
  const result: { [key: string]: string } = {};
  for (const { name, value } of headers) {
    if (name in result)
      result[name] = result[name] + (name.toLowerCase() === 'set-cookie' ? '\n' : ', ') + value;
    else
      result[name] = value;
  }
  return result;
}

// TODO: share with other files
function splitSetCookieHeader(headers: HeadersArray): HeadersArray {
  const index = headers.findIndex(({ name }) => name.toLowerCase() === 'set-cookie');
  if (index === -1)
    return headers;

  const header = headers[index];
  const values = header.value.split('\n');
  if (values.length === 1)
    return headers;
  const result = headers.slice();
  result.splice(index, 1, ...values.map(value => ({ name: header.name, value })));
  return result;
}

// TODO: share with other files
function shouldBypassProxy(hostname: string, bypass?: string): boolean {
  if (!bypass)
    return false;
  const domains = bypass.split(',').map(s => {
    s = s.trim();
    if (!s.startsWith('.'))
      s = '.' + s;
    return s;
  });
  const domain = '.' + hostname;
  return domains.some(d => domain.endsWith(d));
}

function filterHeaders(headers: HeadersArray, filter: (headerName: string) => boolean, revertCorsHeaders?: string[]): { headers: HeadersArray, removedCorsHeaders: string[], unnecessaryCorsPreflight: boolean } {
  const filtered: HeadersArray = [];
  const removedCorsHeaders: string[] = [];
  let corsHeadersReverted = false;
  let unnecessaryCorsPreflight = false;
  for (const entry of headers) {
    if (!filter(entry.name.toLowerCase()))
      continue;
    if (entry.name.toLowerCase() === 'access-control-request-headers') {
      const value = entry.value.split(',').filter(h => {
        if (!filter(h.trim().toLowerCase())) {
          removedCorsHeaders.push(h);
          return false;
        }
        return true;
      }).join(',');
      if (value)
        filtered.push({ name: entry.name, value });
      else
        unnecessaryCorsPreflight = true;
    } else if (revertCorsHeaders?.length && entry.name.toLowerCase() === 'access-control-allow-headers') {
      corsHeadersReverted = true;
      filtered.push({ name: entry.name, value: [entry.value, ...revertCorsHeaders].join(',') });
    } else {
      filtered.push(entry);
    }
  }
  if (revertCorsHeaders?.length && !corsHeadersReverted) {
    filtered.push({ name: 'Access-Control-Allow-Headers', value: revertCorsHeaders.join(',') });
  }
  return { headers: filtered, removedCorsHeaders, unnecessaryCorsPreflight };
}

function rawHeadersToHeadersArray(rawHeaders: string[]) {
  const result: HeadersArray = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    result.push({ name: rawHeaders[i], value: rawHeaders[i + 1] });
  return result;
}

const kRequestIdHeader = 'x-devtools-requestid';
export const kInterceptingHeaderForCorsPreflight = 'x-playwright-intercepting';

const kHeadersToRemoveImmediately = new Set([
	'proxy-authenticate',
	'proxy-authorization',
  'proxy-connection',
  kRequestIdHeader,
  kInterceptingHeaderForCorsPreflight,
]);

// https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Connection
// https://datatracker.ietf.org/doc/html/rfc2616#section-13.5.1
// https://www.rfc-editor.org/rfc/rfc7230#appendix-A.1.2
const kHeadersToRemoveWhenProxying = new Set([
	'connection',
	'keep-alive',
	'te',
	'trailer',
	'trailers',
	'transfer-encoding',
	'upgrade',
]);

// const kHeadersToIgnoreWhenMatchingRequests = new Set([
//   'accept',
//   'accept-encoding',
//   'cache-control',
//   'origin',
//   'pragma',
//   'proxy-connection',
// ]);

// function shouldIgnoreHeaderWhenMatchingRequests(headerName: string) {
//   headerName = headerName.toLowerCase();
//   return headerName.startsWith('sec-') || kHeadersToIgnoreWhenMatchingRequests.has(headerName);
// }

type CA = {
  cert: NodeForge.pki.Certificate;
  rootKeys: NodeForge.pki.rsa.KeyPair;
  childKeys: NodeForge.pki.rsa.KeyPair;
  spki: string;
};

async function generateCA(): Promise<CA> {
  // From https://github.com/digitalbazaar/forge?tab=readme-ov-file#x509
  const keys = nodeForge.pki.rsa.generateKeyPair(2048);
  const cert = nodeForge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = ('00' + crypto.randomBytes(16).toString('hex')).substring(0, 8);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attributes = [
    { name: 'commonName', value: 'PlaywrightCA' },
    { name: 'countryName', value: 'Internet' },
    { shortName: 'ST', value: 'Internet' },
    { name: 'localityName', value: 'Internet' },
    { name: 'organizationName', value: 'Playwright' },
    { shortName: 'OU', value: 'CA' },
  ];
  cert.setSubject(attributes);
  cert.setIssuer(attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, nonRepudiation: true, keyEncipherment: true, dataEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true, codeSigning: true, emailProtection: true, timeStamping: true },
    { name: 'nsCertType', client: true, server: true, email: true, objsign: true, sslCA: true, emailCA: true, objCA: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, nodeForge.md.sha256.create());

  // Note: we reuse keys for all child certificates to be able to calculate
  // SPKI digest before launching the browser and pass it in the allowlist argument.
  // This calculation follows the following instruction from Chromium:
  // https://chromium.googlesource.com/catapult.git/+/221c4e47f4b73d8f126eaac5be442f525326fc48/web_page_replay_go/README.md#generate-public-key-hash-for-ignore_certificate_errors_spki_list
  const childKeys = nodeForge.pki.rsa.generateKeyPair(2048);
  const childPublicKeyDer = nodeForge.pki.pemToDer(nodeForge.pki.publicKeyToPem(childKeys.publicKey));
  const spki = Buffer.from(nodeForge.md.sha256.create().update(childPublicKeyDer.bytes()).digest().bytes(), 'binary').toString('base64');
  return { cert, rootKeys: keys, childKeys, spki };
}

async function generateServerCertificate(ca: CA, hosts: string[]) {
  const keys = ca.childKeys;
  const cert = nodeForge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = ('00' + crypto.randomBytes(16).toString('hex')).substring(0, 8);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  cert.setSubject([
    { name: 'commonName', value: hosts[0] },
    { name: 'countryName', value: 'Internet' },
    { shortName: 'ST', value: 'Internet' },
    { name: 'localityName', value: 'Internet' },
    { name: 'organizationName', value: 'Playwright' },
    { shortName: 'OU', value: 'Playwright Certificate' },
  ]);
  cert.setIssuer(ca.cert.issuer.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', keyCertSign: false, digitalSignature: true, nonRepudiation: false, keyEncipherment: true, dataEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true, codeSigning: false, emailProtection: false, timeStamping: false },
    { name: 'nsCertType', client: true, server: true, email: false, objsign: false, sslCA: false, emailCA: false, objCA: false },
    { name: 'subjectKeyIdentifier' },
    // https://datatracker.ietf.org/doc/html/rfc5280#section-4.2.1.6
    { name: 'subjectAltName', altNames: hosts.map(host => net.isIP(host) ? { type: 7, ip: host } : { type: 2, value: host }) },
  ]);
  cert.sign(ca.rootKeys.privateKey, nodeForge.md.sha256.create());
  const certPem = nodeForge.pki.certificateToPem(cert);
  const keyPem = nodeForge.pki.privateKeyToPem(keys.privateKey);
  return { cert, keys, certPem, keyPem };
}
