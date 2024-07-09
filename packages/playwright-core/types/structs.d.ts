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

import { JSHandle, ElementHandle, Frame, Page, BrowserContext } from './types';
import { EventEmitter } from 'events';

/**
 * Can be converted to JSON
 */
export type Serializable = any;
/**
 * Can be converted to JSON, but may also contain JSHandles.
 */
export type EvaluationArgument = {};

export type NoHandles<Arg> = Arg extends JSHandle ? never : (Arg extends object ? { [Key in keyof Arg]: NoHandles<Arg[Key]> } : Arg);
export type Unboxed<Arg> =
  Arg extends ElementHandle<infer T> ? T :
  Arg extends JSHandle<infer T> ? T :
  Arg extends NoHandles<Arg> ? Arg :
  Arg extends [infer A0] ? [Unboxed<A0>] :
  Arg extends [infer A0, infer A1] ? [Unboxed<A0>, Unboxed<A1>] :
  Arg extends [infer A0, infer A1, infer A2] ? [Unboxed<A0>, Unboxed<A1>, Unboxed<A2>] :
  Arg extends [infer A0, infer A1, infer A2, infer A3] ? [Unboxed<A0>, Unboxed<A1>, Unboxed<A2>, Unboxed<A3>] :
  Arg extends Array<infer T> ? Array<Unboxed<T>> :
  Arg extends object ? { [Key in keyof Arg]: Unboxed<Arg[Key]> } :
  Arg;
export type PageFunction0<R> = string | (() => R | Promise<R>);
export type PageFunction<Arg, R> = string | ((arg: Unboxed<Arg>) => R | Promise<R>);
export type PageFunctionOn<On, Arg2, R> = string | ((on: On, arg2: Unboxed<Arg2>) => R | Promise<R>);
export type SmartHandle<T> = [T] extends [Node] ? ElementHandle<T> : JSHandle<T>;
export type ElementHandleForTag<K extends keyof HTMLElementTagNameMap> = ElementHandle<HTMLElementTagNameMap[K]>;
export type BindingSource = { context: BrowserContext, page: Page, frame: Frame };

export interface InitScriptSource extends EventEmitter {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly frame: Frame;

  /**
   * Emitted when the corresponding in-page channel goes away, for example after navigation.
   */
  on(event: 'disconnected', listener: (source: InitScriptSource) => any): this;

  /**
   * Adds an event listener that will be automatically removed after it is triggered once. See `addListener` for more information about this event.
   */
  once(event: 'disconnected', listener: (source: InitScriptSource) => any): this;

  /**
   * Emitted when the corresponding in-page channel goes away, for example after navigation.
   */
  addListener(event: 'disconnected', listener: (source: InitScriptSource) => any): this;

  /**
   * Removes an event listener added by `on` or `addListener`.
   */
  removeListener(event: 'disconnected', listener: (source: InitScriptSource) => any): this;

  /**
   * Removes an event listener added by `on` or `addListener`.
   */
  off(event: 'disconnected', listener: (source: InitScriptSource) => any): this;

  /**
   * Emitted when the corresponding in-page channel goes away, for example after navigation.
   */
  prependListener(event: 'disconnected', listener: (source: InitScriptSource) => any): this;
};
export type InitScriptPageFunction<Arg> =
  Arg extends (() => Promise<infer R extends object>) ? (f: () => Promise<R>) => any :
  Arg extends ((arg: infer A extends object, source: InitScriptSource) => Promise<infer R extends object>) ? (f: (arg: A) => Promise<R>) => any :
  Arg extends ((arg: infer A extends object) => Promise<infer R extends object>) ? (f: (arg: A) => Promise<R>) => any :
  (PageFunction<Arg, any> | { path?: string, content?: string });
