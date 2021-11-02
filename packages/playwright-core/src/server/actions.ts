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

import * as dom from './dom';
import * as types from './types';
import { Progress } from './progress';

async function scrollRectIntoViewIfNeeded(handle: dom.ElementHandle, rect?: types.Rect): Promise<'error:notvisible' | 'error:notconnected' | 'done'> {
  return await handle._page._delegate.scrollRectIntoViewIfNeeded(handle, rect);
}

async function clickablePoint(handle: dom.ElementHandle): Promise<types.Point | 'error:notvisible' | 'error:notinviewport'> {
  const intersectQuadWithViewport = (quad: types.Quad): types.Quad => {
    return quad.map(point => ({
      x: Math.min(Math.max(point.x, 0), metrics.width),
      y: Math.min(Math.max(point.y, 0), metrics.height),
    })) as types.Quad;
  };

  const computeQuadArea = (quad: types.Quad) => {
    // Compute sum of all directed areas of adjacent triangles
    // https://en.wikipedia.org/wiki/Polygon#Simple_polygons
    let area = 0;
    for (let i = 0; i < quad.length; ++i) {
      const p1 = quad[i];
      const p2 = quad[(i + 1) % quad.length];
      area += (p1.x * p2.y - p2.x * p1.y) / 2;
    }
    return Math.abs(area);
  };

  const [quads, metrics] = await Promise.all([
    handle._page._delegate.getContentQuads(handle),
    handle._page.mainFrame()._utilityContext().then(utility => utility.evaluate(() => ({ width: innerWidth, height: innerHeight }))),
  ] as const);
  if (!quads || !quads.length)
    return 'error:notvisible';

  // Allow 1x1 elements. Compensate for rounding errors by comparing with 0.99 instead.
  const filtered = quads.map(quad => intersectQuadWithViewport(quad)).filter(quad => computeQuadArea(quad) > 0.99);
  if (!filtered.length)
    return 'error:notinviewport';
  // Return the middle point of the first quad.
  const result = { x: 0, y: 0 };
  for (const point of filtered[0]) {
    result.x += point.x / 4;
    result.y += point.y / 4;
  }
  compensateHalfIntegerRoundingError(result);
  return result;
}

async function offsetPoint(handle: dom.ElementHandle, offset: types.Point): Promise<types.Point | 'error:notvisible' | 'error:notconnected'> {
  const [box, border] = await Promise.all([
    handle.boundingBox(),
    handle.evaluateInUtility(([injected, node]) => injected.getElementBorderWidth(node), {}).catch(e => {}),
  ]);
  if (!box || !border)
    return 'error:notvisible';
  if (border === 'error:notconnected')
    return border;
  // Make point relative to the padding box to align with offsetX/offsetY.
  return {
    x: box.x + border.left + offset.x,
    y: box.y + border.top + offset.y,
  };
}

async function retryPointerAction(progress: Progress, handle: dom.ElementHandle, actionName: string, waitForEnabled: boolean, action: (point: types.Point) => Promise<void>,
  options: types.PointerActionOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions): Promise<'error:notconnected' | 'done'> {
  let retry = 0;
  // We progressively wait longer between retries, up to 500ms.
  const waitTime = [0, 20, 100, 100, 500];

  // By default, we scroll with protocol method to reveal the action point.
  // However, that might not work to scroll from under position:sticky elements
  // that overlay the target element. To fight this, we cycle through different
  // scroll alignments. This works in most scenarios.
  const scrollOptions: (ScrollIntoViewOptions | undefined)[] = [
    undefined,
    { block: 'end', inline: 'end' },
    { block: 'center', inline: 'center' },
    { block: 'start', inline: 'start' },
  ];

  while (progress.isRunning()) {
    if (retry) {
      progress.log(`retrying ${actionName} action${options.trial ? ' (trial run)' : ''}, attempt #${retry}`);
      const timeout = waitTime[Math.min(retry - 1, waitTime.length - 1)];
      if (timeout) {
        progress.log(`  waiting ${timeout}ms`);
        const result = await handle.evaluateInUtility(([injected, node, timeout]) => new Promise<void>(f => setTimeout(f, timeout)), timeout);
        if (result === 'error:notconnected')
          return result;
      }
    } else {
      progress.log(`attempting ${actionName} action${options.trial ? ' (trial run)' : ''}`);
    }
    const forceScrollOptions = scrollOptions[retry % scrollOptions.length];
    const result = await performPointerAction(progress, handle, actionName, waitForEnabled, action, forceScrollOptions, options);
    ++retry;
    if (result === 'error:notvisible') {
      if (options.force)
        throw new Error('Element is not visible');
      progress.log('  element is not visible');
      continue;
    }
    if (result === 'error:notinviewport') {
      if (options.force)
        throw new Error('Element is outside of the viewport');
      progress.log('  element is outside of the viewport');
      continue;
    }
    if (typeof result === 'object' && 'hitTargetDescription' in result) {
      if (options.force)
        throw new Error(`Element does not receive pointer events, ${result.hitTargetDescription} intercepts them`);
      progress.log(`  ${result.hitTargetDescription} intercepts pointer events`);
      continue;
    }
    return result;
  }
  return 'done';
}

async function performPointerAction(progress: Progress, handle: dom.ElementHandle, actionName: string, waitForEnabled: boolean, action: (point: types.Point) => Promise<void>, forceScrollOptions: ScrollIntoViewOptions | undefined, options: types.PointerActionOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions): Promise<'error:notvisible' | 'error:notconnected' | 'error:notinviewport' | { hitTargetDescription: string } | 'done'> {
  const { force = false, position } = options;
  if ((options as any).__testHookBeforeStable)
    await (options as any).__testHookBeforeStable();
  const result = await waitForDisplayedAtStablePosition(progress, handle, force, waitForEnabled);
  if (result !== 'done')
    return result;
  if ((options as any).__testHookAfterStable)
    await (options as any).__testHookAfterStable();

  progress.log('  scrolling into view if needed');
  progress.throwIfAborted();  // Avoid action that has side-effects.
  if (forceScrollOptions) {
    const scrolled = await handle.evaluateInUtility(([injected, node, options]) => {
      if (node.nodeType === 1 /* Node.ELEMENT_NODE */)
        (node as Node as Element).scrollIntoView(options);
    }, forceScrollOptions);
    if (scrolled === 'error:notconnected')
      return scrolled;
  } else {
    const scrolled = await scrollRectIntoViewIfNeeded(handle, position ? { x: position.x, y: position.y, width: 0, height: 0 } : undefined);
    if (scrolled !== 'done')
      return scrolled;
  }
  progress.log('  done scrolling');

  const maybePoint = position ? await offsetPoint(handle, position) : await clickablePoint(handle);
  if (typeof maybePoint === 'string')
    return maybePoint;
  const point = roundPoint(maybePoint);

  if (!force) {
    if ((options as any).__testHookBeforeHitTarget)
      await (options as any).__testHookBeforeHitTarget();
    progress.log(`  checking that element receives pointer events at (${point.x},${point.y})`);
    const hitTargetResult = await checkHitTargetAt(handle, point);
    if (hitTargetResult !== 'done')
      return hitTargetResult;
    progress.log(`  element does receive pointer events`);
  }

  progress.metadata.point = point;
  if (options.trial)  {
    progress.log(`  trial ${actionName} has finished`);
    return 'done';
  }

  await progress.beforeInputAction(handle);
  await handle._page._frameManager.waitForSignalsCreatedBy(progress, options.noWaitAfter, async () => {
    if ((options as any).__testHookBeforePointerAction)
      await (options as any).__testHookBeforePointerAction();
    progress.throwIfAborted();  // Avoid action that has side-effects.
    let restoreModifiers: types.KeyboardModifier[] | undefined;
    if (options && options.modifiers)
      restoreModifiers = await handle._page.keyboard._ensureModifiers(options.modifiers);
    progress.log(`  performing ${actionName} action`);
    await action(point);
    progress.log(`  ${actionName} action done`);
    progress.log('  waiting for scheduled navigations to finish');
    if ((options as any).__testHookAfterPointerAction)
      await (options as any).__testHookAfterPointerAction();
    if (restoreModifiers)
      await handle._page.keyboard._ensureModifiers(restoreModifiers);
  }, 'input');
  progress.log('  navigations have finished');

  return 'done';
}

export async function hover(progress: Progress, handle: dom.ElementHandle, options: types.PointerActionOptions & types.PointerActionWaitOptions): Promise<'error:notconnected' | 'done'> {
  return retryPointerAction(progress, handle, 'hover', false /* waitForEnabled */, point => handle._page.mouse.move(point.x, point.y), options);
}

export async function click(progress: Progress, handle: dom.ElementHandle, options: types.MouseClickOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions): Promise<'error:notconnected' | 'done'> {
  return retryPointerAction(progress, handle, 'click', true /* waitForEnabled */, point => handle._page.mouse.click(point.x, point.y, options), options);
}

export async function dblclick(progress: Progress, handle: dom.ElementHandle, options: types.MouseMultiClickOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions): Promise<'error:notconnected' | 'done'> {
  return retryPointerAction(progress, handle, 'dblclick', true /* waitForEnabled */, point => handle._page.mouse.dblclick(point.x, point.y, options), options);
}

export async function tap(progress: Progress, handle: dom.ElementHandle, options: types.PointerActionWaitOptions & types.NavigatingActionWaitOptions): Promise<'error:notconnected' | 'done'> {
  return retryPointerAction(progress, handle, 'tap', true /* waitForEnabled */, point => handle._page.touchscreen.tap(point.x, point.y), options);
}

export async function scrollIntoView(progress: Progress, handle: dom.ElementHandle): Promise<'error:notconnected' | 'done'> {
  while (progress.isRunning()) {
    const stableResult = await waitForDisplayedAtStablePosition(progress, handle, false /* force */, false /* waitForEnabled */);
    if (stableResult !== 'done')
      return stableResult;
    progress.throwIfAborted();  // Avoid action that has side-effects.
    const scrollResult = await scrollRectIntoViewIfNeeded(handle);
    if (scrollResult === 'error:notvisible')
      continue;
    return scrollResult;
  }
  return 'done';
}

export async function drag(progress: Progress, handle: dom.ElementHandle, options: types.DragActionOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions) {
  return retryPointerAction(progress, handle, 'move and down', false, async point => {
    await handle._page.mouse.move(point.x, point.y);
    await handle._page.mouse.down();
  }, { ...options, position: options.sourcePosition });
}

export async function drop(progress: Progress, handle: dom.ElementHandle, options: types.DragActionOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions) {
  return retryPointerAction(progress, handle, 'move and up', false, async point => {
    await handle._page.mouse.move(point.x, point.y);
    await handle._page.mouse.up();
}, { ...options, position: options.targetPosition });
}

async function waitForDisplayedAtStablePosition(progress: Progress, handle: dom.ElementHandle, force: boolean, waitForEnabled: boolean): Promise<'error:notconnected' | 'done'> {
  if (waitForEnabled)
    progress.log(`  waiting for element to be visible, enabled and stable`);
  else
    progress.log(`  waiting for element to be visible and stable`);
  const result = await handle.evaluatePoll(progress, ([injected, node, { waitForEnabled, force }]) => {
    return injected.waitForElementStatesAndPerformAction(node,
        waitForEnabled ? ['visible', 'stable', 'enabled'] : ['visible', 'stable'], force, () => 'done' as const);
  }, { waitForEnabled, force });
  if (result === 'error:notconnected')
    return result;
  if (waitForEnabled)
    progress.log('  element is visible, enabled and stable');
  else
    progress.log('  element is visible and stable');
  return result;
}

async function checkHitTargetAt(handle: dom.ElementHandle, point: types.Point): Promise<'error:notconnected' | { hitTargetDescription: string } | 'done'> {
  const frame = await handle.ownerFrame();
  if (frame && frame.parentFrame()) {
    const element = await frame.frameElement();
    const box = await element.boundingBox();
    if (!box)
      return 'error:notconnected';
    // Translate from viewport coordinates to frame coordinates.
    point = { x: point.x - box.x, y: point.y - box.y };
  }
  return handle.evaluateInUtility(([injected, node, point]) => injected.checkHitTargetAt(node, point), point);
}

function roundPoint(point: types.Point): types.Point {
  return {
    x: (point.x * 100 | 0) / 100,
    y: (point.y * 100 | 0) / 100,
  };
}

function compensateHalfIntegerRoundingError(point: types.Point) {
  // Firefox internally uses integer coordinates, so 8.5 is converted to 9 when clicking.
  //
  // This does not work nicely for small elements. For example, 1x1 square with corners
  // (8;8) and (9;9) is targeted when clicking at (8;8) but not when clicking at (9;9).
  // So, clicking at (8.5;8.5) will effectively click at (9;9) and miss the target.
  //
  // Therefore, we skew half-integer values from the interval (8.49, 8.51) towards
  // (8.47, 8.49) that is rounded towards 8. This means clicking at (8.5;8.5) will
  // be replaced with (8.48;8.48) and will effectively click at (8;8).
  //
  // Other browsers use float coordinates, so this change should not matter.
  const remainderX = point.x - Math.floor(point.x);
  if (remainderX > 0.49 && remainderX < 0.51)
    point.x -= 0.02;
  const remainderY = point.y - Math.floor(point.y);
  if (remainderY > 0.49 && remainderY < 0.51)
    point.y -= 0.02;
}
