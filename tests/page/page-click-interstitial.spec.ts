/**
 * Copyright (c) Microsoft Corporation.
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

import { test, expect } from './pageTest';

test('should work', async ({ page, server }) => {
  await page.goto(server.PREFIX + '/input/interstitial.html');

  let beforeCount = 0;
  let afterCount = 0;
  await page.registerInterstitial(page.getByText('This interstitial covers the button'), async () => {
    ++beforeCount;
    await page.locator('#close').click();
    ++afterCount;
  });

  for (const args of [
    ['mouseover', 1],
    ['mouseover', 1, 'capture'],
    ['mouseover', 2],
    ['mouseover', 2, 'capture'],
    ['pointerover', 1],
    ['pointerover', 1, 'capture'],
    ['none', 1],
    ['remove', 1],
    ['hide', 1],
  ]) {
    await test.step(`${args[0]}${args[2] === 'capture' ? ' with capture' : ''} ${args[1]} times`, async () => {
      await page.locator('#aside').hover();
      beforeCount = 0;
      afterCount = 0;
      await page.evaluate(args => {
        (window as any).clicked = 0;
        (window as any).setupAnnoyingInterstitial(...args);
      }, args);
      expect(beforeCount).toBe(0);
      expect(afterCount).toBe(0);
      await page.locator('#target').click();
      expect(beforeCount).toBe(args[1]);
      expect(afterCount).toBe(args[1]);
      expect(await page.evaluate('window.clicked')).toBe(1);
      await expect(page.locator('#interstitial')).not.toBeVisible();
    });
  }
});

test('should work with a custom check', async ({ page, server }) => {
  await page.goto(server.PREFIX + '/input/interstitial.html');

  await page.registerInterstitial(page.locator('body'), async () => {
    if (await page.getByText('This interstitial covers the button').isVisible())
      await page.locator('#close').click();
  });

  for (const args of [
    ['mouseover', 2],
    ['none', 1],
    ['remove', 1],
    ['hide', 1],
  ]) {
    await test.step(`${args[0]}${args[2] === 'capture' ? ' with capture' : ''} ${args[1]} times`, async () => {
      await page.locator('#aside').hover();
      await page.evaluate(args => {
        (window as any).clicked = 0;
        (window as any).setupAnnoyingInterstitial(...args);
      }, args);
      await page.locator('#target').click();
      expect(await page.evaluate('window.clicked')).toBe(1);
      await expect(page.locator('#interstitial')).not.toBeVisible();
    });
  }
});
