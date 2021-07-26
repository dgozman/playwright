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

import { TestInfo } from '../../types/test';
import { expect } from './expect';
import { setFixtureParameterNames } from './fixtures';
import { currentlyLoadingFileSuite, currentTestInfo, setCurrentlyLoadingFileSuite } from './globals';
import { TestCase, Suite } from './test';
import { wrapFunctionWithLocation } from './transform';
import { Fixtures, FixturesWithLocation, Location, TestType } from './types';
import { errorWithLocation } from './util';

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

    const test: any = wrapFunctionWithLocation(this._createTest.bind(this, 'default'));
    test.expect = expect;
    test.only = wrapFunctionWithLocation(this._createTest.bind(this, 'only'));
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
    test.setTimeout = wrapFunctionWithLocation(this._setTimeout.bind(this));
    test.use = wrapFunctionWithLocation(this._use.bind(this));
    test.extend = wrapFunctionWithLocation(this._extend.bind(this));
    test.declare = wrapFunctionWithLocation(this._declare.bind(this));
    test.case = wrapFunctionWithLocation(this._case.bind(this));
    test.case.step = wrapFunctionWithLocation(this._caseStep.bind(this));
    test.case.fixture = wrapFunctionWithLocation(this._caseFixture.bind(this));
    test.case.testInfo = wrapFunctionWithLocation(this._caseTestInfo.bind(this));
    test.case.extend = wrapFunctionWithLocation(this._caseExtend.bind(this));
    test.case.setup = wrapFunctionWithLocation(this._caseSetup.bind(this));
    test.case.teardown = wrapFunctionWithLocation(this._caseTeardown.bind(this));
    this.test = test;
  }

  private _createTest(type: 'default' | 'only', location: Location, title: string, fn: Function) {
    throwIfRunningInsideJest();
    const suite = currentlyLoadingFileSuite();
    if (!suite)
      throw errorWithLocation(location, `test() can only be called in a test file`);

    const ordinalInFile = countByFile.get(suite._requireFile) || 0;
    countByFile.set(suite._requireFile, ordinalInFile + 1);

    const test = new TestCase(title, fn, ordinalInFile, this, location);
    test._requireFile = suite._requireFile;
    suite._addTest(test);

    if (type === 'only')
      test._only = true;
  }

  private _describe(type: 'default' | 'only', location: Location, title: string, fn: Function) {
    throwIfRunningInsideJest();
    const suite = currentlyLoadingFileSuite();
    if (!suite)
      throw errorWithLocation(location, `describe() can only be called in a test file`);

    if (typeof title === 'function') {
      throw errorWithLocation(location, [
        'It looks like you are calling describe() without the title. Pass the title as a first argument:',
        `test.describe('my test group', () => {`,
        `  // Declare tests here`,
        `});`,
      ].join('\n'));
    }

    const child = new Suite(title);
    child._requireFile = suite._requireFile;
    child.location = location;
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
      throw errorWithLocation(location, `${name} hook can only be called in a test file`);
    suite._hooks.push({ type: name, fn, location });
  }

  private _modifier(type: 'skip' | 'fail' | 'fixme' | 'slow', location: Location, ...modifierArgs: [arg?: any | Function, description?: string]) {
    const suite = currentlyLoadingFileSuite();
    if (suite) {
      if (typeof modifierArgs[0] === 'function') {
        suite._modifiers.push({ type, fn: modifierArgs[0], location, description: modifierArgs[1] });
      } else {
        if (modifierArgs.length >= 1 && !modifierArgs[0])
          return;
        const description = modifierArgs[1];
        suite._annotations.push({ type, description });
      }
      return;
    }

    const testInfo = currentTestInfo();
    if (!testInfo)
      throw errorWithLocation(location, `test.${type}() can only be called inside test, describe block or fixture`);
    if (typeof modifierArgs[0] === 'function')
      throw errorWithLocation(location, `test.${type}() with a function can only be called inside describe block`);
    testInfo[type](...modifierArgs as [any, any]);
  }

  private _setTimeout(location: Location, timeout: number) {
    const suite = currentlyLoadingFileSuite();
    if (suite) {
      suite._timeout = timeout;
      return;
    }

    const testInfo = currentTestInfo();
    if (!testInfo)
      throw errorWithLocation(location, `test.setTimeout() can only be called from a test file`);
    testInfo.setTimeout(timeout);
  }

  private _use(location: Location, fixtures: Fixtures) {
    const suite = currentlyLoadingFileSuite();
    if (!suite)
      throw errorWithLocation(location, `test.use() can only be called in a test file`);
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

  private _case(location: Location, title: string | undefined) {
    return (descriptor: any) => {
      if (descriptor.kind !== 'class')
        throw errorWithLocation(location, `@test.case() decorator should be used on classes`);
      return {
        ...descriptor,
        finisher: (ctr: (new() => any)) => {
          this._createTest('default', location, title || ctr.name, createTestCaseFunction(ctr));
        }
      };
    };
  }

  private _caseStep(location: Location, title: string | undefined) {
    return (descriptor: any) => {
      if (descriptor.kind !== 'method')
        throw errorWithLocation(location, `@test.case.step() decorator should be used on class methods`);
      return {
        ...descriptor,
        finisher: (ctr: (new() => any)) => {
          ensureClassData(ctr).steps.push({ title: title || descriptor.key, method: descriptor.key });
        },
      }
    };
  }

  private _caseFixture(location: Location, name: string | undefined) {
    return (descriptor: any) => {
      if (descriptor.kind !== 'field')
        throw errorWithLocation(location, `@test.case.fixture() decorator should be used on class fields`);
      return {
        ...descriptor,
        finisher: (ctr: (new() => any)) => {
          ensureClassData(ctr).fixtures.push({ name: name || descriptor.key, field: descriptor.key });
        },
      }
    };
  }

  private _caseTestInfo(location: Location) {
    return (descriptor: any) => {
      if (descriptor.kind !== 'field')
        throw errorWithLocation(location, `@test.case.testInfo() decorator should be used on class fields`);
      return {
        ...descriptor,
        finisher: (ctr: (new() => any)) => {
          ensureClassData(ctr).testInfos.push({ field: descriptor.key });
        },
      }
    };
  }

  private _caseSetup(location: Location, title: string | undefined) {
    return (descriptor: any) => {
      if (descriptor.kind !== 'method')
        throw errorWithLocation(location, `@test.case.setup() decorator should be used on class methods`);
      return {
        ...descriptor,
        finisher: (ctr: (new() => any)) => {
          ensureClassData(ctr).setups.push({ title: title || descriptor.key, method: descriptor.key });
        },
      }
    };
  }

  private _caseTeardown(location: Location, title: string | undefined) {
    return (descriptor: any) => {
      if (descriptor.kind !== 'method')
        throw errorWithLocation(location, `@test.case.teardown() decorator should be used on class methods`);
      return {
        ...descriptor,
        finisher: (ctr: (new() => any)) => {
          ensureClassData(ctr).teardowns.push({ title: title || descriptor.key, method: descriptor.key });
        },
      }
    };
  }

  private _caseExtend(location: Location, name: string, ctr: (new() => any)) {
    // Somehow check ctr is a class constructor?
    if (ensureClassData(ctr).steps.length)
      throw errorWithLocation(location, `Fixture added with test.case.extend cannot define @test.case.step()`);
    const fixturesWithLocation = { fixtures: { [name]: createTestCaseFixture(ctr) }, location };
    return new TestTypeImpl([...this.fixtures, fixturesWithLocation]).test;
  }
}

function throwIfRunningInsideJest() {
  if (process.env.JEST_WORKER_ID) {
    throw new Error(
        `Playwright Test needs to be invoked via 'npx playwright test' and excluded from Jest test runs.\n` +
        `Creating one directory for Playwright tests and one for Jest is the recommended way of doing it.\n` +
        `See https://playwright.dev/docs/intro/ for more information about Playwright Test.`,
    );
  }
}

export const rootTestType = new TestTypeImpl([]);

const kClassData = Symbol('classdata');
type ClassData = {
  fixtures: { name: string, field: string }[],
  testInfos: { field: string }[],
  steps: { title: string, method: string }[],
  setups: { title: string, method: string }[],
  teardowns: { title: string, method: string }[],
};
function cloneClassData(data: ClassData): ClassData {
  return {
    fixtures: [...data.fixtures],
    testInfos: [...data.testInfos],
    steps: [...data.steps],
    setups: [...data.setups],
    teardowns: [...data.teardowns],
  };
}
function ensureClassData(cls: any): ClassData {
  let data: ClassData = cls[kClassData];
  if (!data) {
    data = { fixtures: [], testInfos: [], steps: [], setups: [], teardowns: [] };
    cls[kClassData] = data;
  } else if (!cls.hasOwnProperty(kClassData)) {
    // When X extends A, we get original data from A (via __proto__) and make an isolated copy for X.
    // - This way we inherit all decorators from the parent class.
    // - When both X and Y extend the same base A, they get isolated data and separate steps.
    data = cloneClassData(data);
    cls[kClassData] = data;
  }
  return data;
}

function createTestCaseFunction(ctr: (new() => any)) {
  const data = ensureClassData(ctr);
  const fn = async (fixtures: any, testInfo: TestInfo) => {
    const instance = new ctr();
    for (const { name, field } of data.fixtures)
      instance[field] = fixtures[name];
    for (const { field } of data.testInfos)
      instance[field] = testInfo;
    for (const { title, method } of data.setups) {
      (testInfo as any)._emitTestStep(title);
      await instance[method]();
    }
    for (const { title, method } of data.steps) {
      (testInfo as any)._emitTestStep(title);
      await instance[method]();
    }
    for (const { title, method } of data.teardowns) {
      (testInfo as any)._emitTestStep(title);
      await instance[method]();
    }
  };
  setFixtureParameterNames(fn, data.fixtures.map(f => f.name));
  return fn;
}

function createTestCaseFixture(ctr: (new() => any)) {
  const data = ensureClassData(ctr);
  const fn = async (fixtures: any, use: (r: any) => Promise<void>, testInfo: TestInfo) => {
    const instance = new ctr();
    for (const { name, field } of data.fixtures)
      instance[field] = fixtures[name];
    for (const { field } of data.testInfos)
      instance[field] = testInfo;
    for (const { title, method } of data.setups) {
      (testInfo as any)._emitTestStep(title);
      await instance[method]();
    }
    await use(instance);
    for (const { title, method } of data.teardowns) {
      (testInfo as any)._emitTestStep(title);
      await instance[method]();
    }
  };
  setFixtureParameterNames(fn, data.fixtures.map(f => f.name));
  return fn;
}
