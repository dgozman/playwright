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

import { devices, defineConfig } from '@playwright/experimental-ct-react';
import type { ReporterDescription } from '@playwright/test';

const reporters = () => {
  const result: ReporterDescription[] = process.env.CI ? [
    ['html'],
    ['blob'],
  ] : [
    ['html']
  ];
  return result;
};

const config = defineConfig({
  testDir: 'src',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: reporters(),
  use: {
    ctPort: 3102,
    trace: 'on-first-retry',
  },
  ignoreSnapshots: true,
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

if (process.env.PLAYWRIGHT_SERVICE_ACCESS_KEY) {
  const os = 'linux';
  const runId = process.env.PLAYWRIGHT_SERVICE_RUN_ID || new Date().toISOString();
  process.env.PLAYWRIGHT_SERVICE_RUN_ID = runId;

  const versionMatch = require('../playwright/package.json').version.match(/1\.(\d+)\.0-next/);
  if (versionMatch)
    process.env.PW_VERSION_OVERRIDE = '1.' + String(+versionMatch[1] - 1);

  config.ignoreSnapshots = false;
  config.snapshotPathTemplate = `{testDir}/__screenshots__/{testFilePath}/${os}/{arg}{ext}`;

  config.projects!.push({
    name: 'service',
    retries: 0,
    use: {
      ...devices['Desktop Chrome'],
      trace: 'on',
      connectOptions: {
        wsEndpoint: `${process.env.PLAYWRIGHT_SERVICE_URL}?cap=${JSON.stringify({ os, runId })}`,
        timeout: 3 * 60 * 1000,
        exposeNetwork: '<loopback>',
        headers: {
          'x-mpt-access-key': process.env.PLAYWRIGHT_SERVICE_ACCESS_KEY!,
        },
      },
    },
  });
}

export default config;
