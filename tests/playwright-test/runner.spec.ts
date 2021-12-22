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
import path from 'path';
import { test, expect, stripAscii } from './playwright-test-fixtures';

test('it should not allow multiple tests with the same name per suite', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'tests/example.spec.js': `
      const { test } = pwt;
      test('i-am-a-duplicate', async () => {});
      test('i-am-a-duplicate', async () => {});
    `
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('duplicate test titles are not allowed');
  expect(result.output).toContain(`- title: i-am-a-duplicate`);
  expect(result.output).toContain(`  - tests${path.sep}example.spec.js:6`);
  expect(result.output).toContain(`  - tests${path.sep}example.spec.js:7`);
});

test('it should enforce unique test names based on the describe block name', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'tests/example.spec.js': `
      const { test } = pwt;
      test.describe('hello', () => { test('my world', () => {}) });
      test.describe('hello my', () => { test('world', () => {}) });
      test('hello my world', () => {});
    `
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('duplicate test titles are not allowed');
  expect(result.output).toContain(`- title: hello my world`);
  expect(result.output).toContain(`  - tests${path.sep}example.spec.js:6`);
  expect(result.output).toContain(`  - tests${path.sep}example.spec.js:7`);
  expect(result.output).toContain(`  - tests${path.sep}example.spec.js:8`);
});

test('it should not allow a focused test when forbid-only is used', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'tests/focused-test.spec.js': `
      const { test } = pwt;
      test.only('i-am-focused', async () => {});
    `
  }, { 'forbid-only': true });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('--forbid-only found a focused test.');
  expect(result.output).toContain(`- tests${path.sep}focused-test.spec.js:6 > i-am-focused`);
});

test('it should not hang and report results when worker process suddenly exits', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.js': `
      const { test } = pwt;
      test('passed1', () => {});
      test('passed2', () => {});
      test('failed1', () => { process.exit(0); });
      test('skipped', () => {});
    `
  });
  expect(result.exitCode).toBe(1);
  expect(result.passed).toBe(2);
  expect(result.failed).toBe(1);
  expect(result.skipped).toBe(1);
  expect(result.output).toContain('Worker process exited unexpectedly');
});

test('sigint should stop workers', async ({ runInlineTest }) => {
  test.skip(process.platform === 'win32', 'No sending SIGINT on Windows');

  const result = await runInlineTest({
    'a.spec.js': `
      const { test } = pwt;
      test('interrupted1', async () => {
        console.log('\\n%%SEND-SIGINT%%1');
        await new Promise(f => setTimeout(f, 3000));
      });
      test('skipped1', async () => {
        console.log('\\n%%skipped1');
      });
    `,
    'b.spec.js': `
      const { test } = pwt;
      test('interrupted2', async () => {
        console.log('\\n%%SEND-SIGINT%%2');
        await new Promise(f => setTimeout(f, 3000));
      });
      test('skipped2', async () => {
        console.log('\\n%%skipped2');
      });
    `,
  }, { 'workers': 2 }, {}, { sendSIGINTAfter: 2 });
  expect(result.exitCode).toBe(130);
  expect(result.passed).toBe(0);
  expect(result.failed).toBe(0);
  expect(result.skipped).toBe(4);
  expect(result.output).toContain('%%SEND-SIGINT%%1');
  expect(result.output).toContain('%%SEND-SIGINT%%2');
  expect(result.output).not.toContain('%%skipped1');
  expect(result.output).not.toContain('%%skipped2');
});

test('should use the first occurring error when an unhandled exception was thrown', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'unhandled-exception.spec.js': `
      const test = pwt.test.extend({
        context: async ({}, test) => {
          await test(123)
          let errorWasThrownPromiseResolve = () => {}
          const errorWasThrownPromise = new Promise(resolve => errorWasThrownPromiseResolve = resolve);
          setTimeout(() => {
            errorWasThrownPromiseResolve();
            throw new Error('second error');
          }, 0)
          await errorWasThrownPromise;
        },
        page: async ({ context}, test) => {
          throw new Error('first error');
          await test(123)
        },
      });

      test('my-test', async ({ page }) => { });
    `
  });
  expect(result.exitCode).toBe(1);
  expect(result.passed).toBe(0);
  expect(result.failed).toBe(1);
  expect(result.report.suites[0].specs[0].tests[0].results[0].error.message).toBe('first error');
});

test('worker interrupt should report errors', async ({ runInlineTest }) => {
  test.skip(process.platform === 'win32', 'No sending SIGINT on Windows');

  const result = await runInlineTest({
    'a.spec.js': `
      const test = pwt.test.extend({
        throwOnTeardown: async ({}, use) => {
          let reject;
          await use(new Promise((f, r) => reject = r));
          reject(new Error('INTERRUPT'));
        },
      });
      test('interrupted', async ({ throwOnTeardown }) => {
        console.log('\\n%%SEND-SIGINT%%');
        await throwOnTeardown;
      });
    `,
  }, {}, {}, { sendSIGINTAfter: 1 });
  expect(result.exitCode).toBe(130);
  expect(result.passed).toBe(0);
  expect(result.failed).toBe(0);
  expect(result.skipped).toBe(1);
  expect(result.output).toContain('%%SEND-SIGINT%%');
  expect(result.output).toContain('Error: INTERRUPT');
});

test('should not stall when workers are available', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.js': `
      const { test } = pwt
      test('fails-1', async () => {
        console.log('\\n%%fails-1-started');
        await new Promise(f => setTimeout(f, 2000));
        console.log('\\n%%fails-1-done');
        expect(1).toBe(2);
      });
      test('passes-1', async () => {
        console.log('\\n%%passes-1');
      });
    `,
    'b.spec.js': `
      const { test } = pwt
      test('passes-2', async () => {
        await new Promise(f => setTimeout(f, 1000));
        console.log('\\n%%passes-2-started');
        await new Promise(f => setTimeout(f, 3000));
        console.log('\\n%%passes-2-done');
      });
    `,
  }, { workers: 2 });
  expect(result.exitCode).toBe(1);
  expect(result.passed).toBe(2);
  expect(result.failed).toBe(1);
  expect(stripAscii(result.output).split('\n').filter(line => line.startsWith('%%'))).toEqual([
    '%%fails-1-started',
    '%%passes-2-started',
    '%%fails-1-done',
    '%%passes-1',
    '%%passes-2-done',
  ]);
});

test('should suport runTests api', async ({ writeFiles, childProcess }) => {
  const baseDir = await writeFiles({
    'playwright.config.js': `
      module.exports = {
        projects: [
          { name: 'foo' },
          { name: 'bar' },
        ],
      };
    `,
    'a.spec.ts': `
      const { test } = pwt;
      test('my test', async () => {
        console.log('my output');
        await new Promise(f => setTimeout(f, 1000));
      });
      test('passing', async () => {
      });
    `,
    'program.js': `
      const { runTests } = require('@playwright/test/runner');
      const { expect } = require('@playwright/test');
      (async () => {
        console.log('running all projects');
        const r1 = await runTests({ overrides: { reporter: 'dot', workers: 2 } });
        expect(r1.result.status).toBe('passed');
        expect(r1.config.projects.length).toBe(2);
        expect(r1.suite.suites.length).toBe(2);  // project suites
        expect(r1.suite.allTests().length).toBe(4);
        expect(r1.suite.suites[0].suites[0].tests[0].results[0].stdout[0]).toContain('my output');

        console.log('running one project');
        const r2 = await runTests({ overrides: { reporter: 'dot', workers: 2, timeout: 500 }, project: ['foo'] });
        expect(r2.result.status).toBe('failed');
        expect(r2.config.projects.length).toBe(2);
        expect(r2.suite.suites.length).toBe(1);  // project suites
        expect(r2.suite.allTests().length).toBe(2);
      })();
    `
  });
  const child = childProcess({
    command: ['node', path.join(baseDir, 'program.js')],
    cwd: baseDir,
  });
  await child.cleanExit();

  const lines = stripAscii(child.output).split('\n').map(line => line.trim().replace(/\([\dms]+\)/, '(X)')).filter(line => !!line);
  const expected = [
    'running all projects',
    'Running 4 tests using 2 workers',
    'my output',
    'my output',
    '····',
    '4 passed (X)',
    'running one project',
    'Running 2 tests using 1 worker',
    'my output',
    'T·',
    '1) [foo] › a.spec.ts:6:7 › my test ===============================================================',
  ];
  expect(lines.slice(0, expected.length)).toEqual(expected);
});
