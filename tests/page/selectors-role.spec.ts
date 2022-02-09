/**
 * Copyright 2018 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
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

import { test as it, expect } from './pageTest';

it('should work with roles', async ({ page }) => {
  await page.setContent(`
    <button>Hello</button>
    <select multiple="" size="2"></select>
    <select></select>
    <h3>Heading</h3>
    <details><summary>Hello</summary></details>
    <div role="dialog">I am a dialog</div>
  `);
  expect(await page.$eval(`role=button`, e => e.outerHTML)).toBe('<button>Hello</button>');
  expect(await page.$eval(`role=listbox`, e => e.outerHTML)).toBe('<select multiple="" size="2"></select>');
  expect(await page.$eval(`role=combobox`, e => e.outerHTML)).toBe('<select></select>');
  expect(await page.$eval(`role=heading`, e => e.outerHTML)).toBe('<h3>Heading</h3>');
  expect(await page.$eval(`role=group`, e => e.outerHTML)).toBe('<details><summary>Hello</summary></details>');
  expect(await page.$eval(`role=dialog`, e => e.outerHTML)).toBe('<div role="dialog">I am a dialog</div>');
  expect(await page.$(`role=menuitem`)).toBe(null);
});

it.fixme('should support selected', async ({ page, server }) => {
});

it.fixme('should support checked', async ({ page, server }) => {
});

it.fixme('should support pressed', async ({ page, server }) => {
});

it.fixme('should support expanded', async ({ page, server }) => {
});

it.fixme('should filter hidden', async ({ page, server }) => {
});

it.fixme('should filter hidden through shadow dom', async ({ page, server }) => {
});

it.fixme('should include hidden=true', async ({ page, server }) => {
});

it.fixme('should support level', async ({ page, server }) => {
});

it.fixme('should support name with hidden=true', async ({ page, server }) => {
});

it.fixme('should support name and regexp', async ({ page, server }) => {
});

it.fixme('should support name - all kinds of tests here', async ({ page, server }) => {
});

it.fixme('parsing', async ({ page, server }) => {
  // role=foo[bar]
  // role=foo[bar.qux=true]
  // role=foo[level="bar"]
  // role=foo[checked="bar"]
  // role=foo[checked~=true]
});
