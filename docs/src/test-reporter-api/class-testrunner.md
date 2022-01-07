# class: TestRunner
* langs: js

[TestRunner] allows to run Playwright tests programmatically.

```js js-flavor=js
// @ts-check

const { TestRunner } = require('@playwright/test/reporter');

async function runTests() {
  // Prepare to run tests in a single worker in headed mode.
  const runner = new TestRunner({
    configOverrides: { workers: 1, use: { headless: false } },
  });
  // Load configuration file from the current directory, if one exists.
  await runner.loadConfigFromFile(process.cwd());
  // Run all tests from the 'my-project' project.
  const { result, suite, config } = await runner.runAllTests({
    projectFilter: ['my-project'],
  });
  // Check the result.
  console.log(result);
}
```

```js js-flavor=ts
import { TestRunner } from '@playwright/test/reporter';

async function runTests() {
  // Prepare to run tests in a single worker in headed mode.
  const runner = new TestRunner({
    configOverrides: { workers: 1, use: { headless: false } },
  });
  // Load configuration file from the current directory, if one exists.
  await runner.loadConfigFromFile(process.cwd());
  // Run all tests from the 'my-project' project.
  const { result, suite, config } = await runner.runAllTests({
    projectFilter: ['my-project'],
  });
  // Check the result.
  console.log(result);
}
```

## method: TestRunner.constructor

Creates a test runner.

### option: TestRunner.constructor.configOverrides
- `configOverrides` <[TestConfig]>

Configuration overrides, applied after reading configuration file (if any).


## async method: TestRunner.loadConfigFromFile

Loads a configuration file if any, or a default configuration. This method must be called once after creating a [TestRunner].

### param: TestRunner.loadConfigFromFile.configFileOrDirectory
- `configFileOrDirectory` <[string]>

Path to the configuration file, or base testing directory. It is often convenient to pass `process.cwd()`.


## async method: TestRunner.runAllTests
- returns: <[Object]>
  - `config` <[TestConfig]> Full resolved configuration.
  - `result` <[Object]> Final result of the run.
    - `status` <[FullStatus]<"passed"|"failed"|"timedout"|"interrupted">>
  - `suite` <[Suite]> Root suite that contains all tests scheduled to run.

Filters available tests and runs them. Returns:
* The full resolved `config` that takes into account the loaded configuration file as well as configuration overrides.
* The root `suite` that contains all test to be run, filtered by the [`option: projectFilter`] and [`option: testFilter`].
* The final result with the status of the run.
  * `'passed'` - Everything went as expected.
  * `'failed'` - Any test has failed.
  * `'timedout'` - The [`property: TestConfig.globalTimeout`] has been reached.
  * `'interrupted'` - Interrupted by the user.


### option: TestRunner.runAllTests.projectFilter
- `projectFilter` <[Array]<[string]>>

List of projects to run. When omitted, all projects are run.

### option: TestRunner.runAllTests.testFilter
- `testFilter` <[Array]<[Object]>>
  - `re` <[RegExp]> Regular expression to match against the full path to the test file.
  - `line` <[number]|[void]> Optional line number of the test location inside the test file.

List of test filters. Only tests that match one of the filters will be run. When omitted, all tests are run.
