/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
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

import React from 'react';
import { expect as baseExpect, test } from '@playwright/experimental-ct-react';
import type { Locator } from '@playwright/test';
import { SplitView } from './splitView';

const expect = baseExpect.extend({
  async toHaveBoundingBox(locator: Locator, expected: any) {
    const name = 'toHaveBoundingBox';
    try {
      await expect.poll(() => locator.boundingBox()).toEqual(expected);
      return { pass: true, expected, name, message: () => '' };
    } catch (e) {
      const message = () => this.utils.matcherHint(name, undefined, undefined, { isNot: this.isNot }) +
          '\n\n' +
          `Locator: ${locator}\n` +
          `Expected: ${this.utils.printExpected(expected)}\n` +
          (e.matcherResult ? `Received: ${this.utils.printReceived(e.matcherResult.actual)}` : '');
      return { pass: false, expected, name, actual: e.matcherResult?.actual, message };
    }
  },
});

test.use({ viewport: { width: 500, height: 500 } });

test('should render', async ({ mount }) => {
  const component = await mount(<SplitView sidebarSize={100}>
    <div id='main' style={{ border: '1px solid red', flex: 'auto' }}>main</div>
    <div id='sidebar' style={{ border: '1px solid blue', flex: 'auto' }}>sidebar</div>
  </SplitView>);
  await expect.soft(component.locator('#main')).toHaveBoundingBox({ x: 0, y: 0, width: 500, height: 400 });
  await expect.soft(component.locator('#sidebar')).toHaveBoundingBox({ x: 0, y: 401, width: 500, height: 99 });
});

test('should render sidebar first', async ({ mount }) => {
  const component = await mount(<SplitView sidebarSize={100} sidebarIsFirst={true}>
    <div id='main' style={{ border: '1px solid blue', flex: 'auto' }}>main</div>
    <div id='sidebar' style={{ border: '1px solid red', flex: 'auto' }}>sidebar</div>
  </SplitView>);
  await expect.soft(component.locator('#main')).toHaveBoundingBox({ x: 0, y: 100, width: 500, height: 400 });
  await expect.soft(component.locator('#sidebar')).toHaveBoundingBox({ x: 0, y: 0, width: 500, height: 99 });
});

test('should render horizontal split', async ({ mount }) => {
  const component = await mount(<SplitView sidebarSize={100} sidebarIsFirst={true} orientation={'horizontal'}>
    <div id='main' style={{ border: '1px solid blue', flex: 'auto' }}>main</div>
    <div id='sidebar' style={{ border: '1px solid red', flex: 'auto' }}>sidebar</div>
  </SplitView>);
  await expect.soft(component.locator('#main')).toHaveBoundingBox({ x: 100, y: 0, width: 400, height: 500 });
  await expect.soft(component.locator('#sidebar')).toHaveBoundingBox({ x: 0, y: 0, width: 99, height: 500 });
});

test('should hide sidebar', async ({ mount }) => {
  const component = await mount(<SplitView sidebarSize={100} orientation={'horizontal'} sidebarHidden={true}>
    <div id='main' style={{ border: '1px solid blue', flex: 'auto' }}>main</div>
    <div id='sidebar' style={{ border: '1px solid red', flex: 'auto' }}>sidebar</div>
  </SplitView>);
  await expect.soft(component.locator('#main')).toHaveBoundingBox({ x: 0, y: 0, width: 500, height: 500 });
});

test('drag resize', async ({ page, mount }) => {
  const component = await mount(<SplitView sidebarSize={100}>
    <div id='main' style={{ border: '1px solid blue', flex: 'auto' }}>main</div>
    <div id='sidebar' style={{ border: '1px solid red', flex: 'auto' }}>sidebar</div>
  </SplitView>);
  await page.mouse.move(25, 400);
  await page.mouse.down();
  await page.mouse.move(25, 100);
  await page.mouse.up();
  await expect.soft(component.locator('#main')).toHaveBoundingBox({ x: 0, y: 0, width: 500, height: 100 });
  await expect.soft(component.locator('#sidebar')).toHaveBoundingBox({ x: 0, y: 101, width: 500, height: 399 });
});

