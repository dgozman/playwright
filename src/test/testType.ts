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

import { expect } from './expect';
import { currentlyLoadingFileSuite, currentTestInfo, setCurrentlyLoadingFileSuite } from './globals';
import { Spec, Suite } from './test';
import { wrapFunctionWithLocation } from './util';
import { Fixtures, FixturesWithLocation, Location, TestInfo, TestType } from './types';
import { inheritFixtureParameterNames } from './fixtures';

const countByFile = new Map<string, number>();

export class DeclaredFixtures {
  testType!: TestTypeImpl;
  location!: Location;
}

export class TestTypeImpl {
  readonly fixtures: (FixturesWithLocation | DeclaredFixtures)[];
  readonly test: TestType<any, any>;

  constructor(fixtures: (FixturesWithLocation | DeclaredFixtures)[]) {
    this.fixtures = fixtures;

    const test: any = wrapFunctionWithLocation(this._spec.bind(this, 'default'));
    test.expect = expect;
    test.only = wrapFunctionWithLocation(this._spec.bind(this, 'only'));
    test.describe = wrapFunctionWithLocation(this._describe.bind(this, 'default'));
    test.describe.only = wrapFunctionWithLocation(this._describe.bind(this, 'only'));
    test.beforeEach = wrapFunctionWithLocation(this._hook.bind(this, 'beforeEach'));
    test.afterEach = wrapFunctionWithLocation(this._hook.bind(this, 'afterEach'));
    test.beforeAll = wrapFunctionWithLocation(this._hook.bind(this, 'beforeAll'));
    test.afterAll = wrapFunctionWithLocation(this._hook.bind(this, 'afterAll'));
    test.skip = wrapFunctionWithLocation(this._modifier.bind(this, 'skip'));
    test.fixme = wrapFunctionWithLocation(this._modifier.bind(this, 'fixme'));
    test.fail = wrapFunctionWithLocation(this._modifier.bind(this, 'fail'));
    test.slow = wrapFunctionWithLocation(this._modifier.bind(this, 'slow'));
    test.setTimeout = this._setTimeout.bind(this);
    test.use = wrapFunctionWithLocation(this._use.bind(this));
    test.extend = wrapFunctionWithLocation(this._extend.bind(this));
    test.declare = wrapFunctionWithLocation(this._declare.bind(this));
    this.test = test;
  }

  private _spec(type: 'default' | 'only', location: Location, title: string, fn: Function) {
    const suite = currentlyLoadingFileSuite();
    if (!suite)
      throw new Error(`test() can only be called in a test file`);

    const ordinalInFile = countByFile.get(suite._requireFile) || 0;
    countByFile.set(suite._requireFile, ordinalInFile + 1);

    const spec = new Spec(title, fn, ordinalInFile, this);
    spec._requireFile = suite._requireFile;
    spec.file = location.file;
    spec.line = location.line;
    spec.column = location.column;
    suite._addSpec(spec);

    if (type === 'only')
      spec._only = true;
  }

  private _describe(type: 'default' | 'only', location: Location, title: string, fn: Function) {
    const suite = currentlyLoadingFileSuite();
    if (!suite)
      throw new Error(`describe() can only be called in a test file`);

    const child = new Suite(title);
    child._requireFile = suite._requireFile;
    child.file = location.file;
    child.line = location.line;
    child.column = location.column;
    suite._addSuite(child);

    if (type === 'only')
      child._only = true;

    setCurrentlyLoadingFileSuite(child);
    fn();
    setCurrentlyLoadingFileSuite(suite);
  }

  private _hook(name: 'beforeEach' | 'afterEach' | 'beforeAll' | 'afterAll', location: Location, fn: Function) {
    const suite = currentlyLoadingFileSuite();
    if (!suite)
      throw new Error(`${name} hook can only be called in a test file`);
    suite._hooks.push({ type: name, fn, location });
  }

  private _modifier(type: 'skip' | 'fail' | 'fixme' | 'slow', location: Location, ...modiferAgs: [arg?: any | Function, description?: string]) {
    const suite = currentlyLoadingFileSuite();
    if (suite) {
      if (typeof modiferAgs[0] === 'function') {
        const [conditionFn, description] = modiferAgs;
        const fn = (args: any, testInfo: TestInfo) => testInfo[type](conditionFn(args), description!);
        inheritFixtureParameterNames(conditionFn, fn, location);
        suite._hooks.unshift({ type: 'beforeEach', fn, location });
      } else {
        const fn = ({}: any, testInfo: TestInfo) => testInfo[type](...modiferAgs as [any, any]);
        suite._hooks.unshift({ type: 'beforeEach', fn, location });
      }
      return;
    }

    const testInfo = currentTestInfo();
    if (!testInfo)
      throw new Error(`test.${type}() can only be called inside test, describe block or fixture`);
    if (typeof modiferAgs[0] === 'function')
      throw new Error(`test.${type}() with a function can only be called inside describe block`);
    testInfo[type](...modiferAgs as [any, any]);
  }

  private _setTimeout(timeout: number) {
    const testInfo = currentTestInfo();
    if (!testInfo)
      throw new Error(`test.setTimeout() can only be called inside test or fixture`);
    testInfo.setTimeout(timeout);
  }

  private _use(location: Location, fixtures: Fixtures) {
    const suite = currentlyLoadingFileSuite();
    if (!suite)
      throw new Error(`test.use() can only be called in a test file`);
    suite._fixtureOverrides = { ...suite._fixtureOverrides, ...fixtures };
  }

  private _extend(location: Location, fixtures: Fixtures) {
    const fixturesWithLocation = { fixtures, location };
    return new TestTypeImpl([...this.fixtures, fixturesWithLocation]).test;
  }

  private _declare(location: Location) {
    const declared = new DeclaredFixtures();
    declared.location = location;
    const child = new TestTypeImpl([...this.fixtures, declared]);
    declared.testType = child;
    return child.test;
  }
}

export const rootTestType = new TestTypeImpl([]);
