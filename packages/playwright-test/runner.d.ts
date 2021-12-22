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

import { Config } from './types/test';
import { Suite, FullResult, FullConfig } from './types/testReporter';

type RunTestsParams = {
  // Path to the configuration file if any.
  config?: string;

  // Whether to run in headed mode.
  headed?: boolean;

  // Specific projects to run. Defaults to running all projects.
  project?: string[];

  // Configuration overrides. For example, pass `{ timeout: 0 }` to disable timeouts.
  overrides?: Config;

  // Files patterns to filter tests, an array of `<partial file path>[:<optional line number>]`.
  filePatterns?: string[];
};

type RunTestsResult = {
  // Resolved config.
  config: FullConfig;

  // Root suite that contains all tests scheduled to run.
  suite: Suite;

  // Final result of the run.
  result: FullResult;
};
export function runTests(params: RunTestsParams): Promise<RunTestsResult>;

export {};
