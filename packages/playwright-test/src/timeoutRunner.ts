/**
 * Copyright Microsoft Corporation. All rights reserved.
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

import { ManualPromise } from 'playwright-core/lib/utils/async';
import { monotonicTime } from './util';

type TimeoutData = {
  timeout: number;
  elapsed: number;
};

export class TimeoutRunnerError extends Error {}

export interface TimeSlot {
  // When slot has no timeout data, it uses default shared timeout data.
  timeoutData: TimeoutData | 'shared';
}

type RunningTimeout = {
  slot: TimeSlot,
  start: number,
  timer: NodeJS.Timer | undefined,
  timeoutPromise: ManualPromise<any>,
};

export class TimeoutRunner {
  private _defaultSlot = { timeoutData: { timeout: 0, elapsed: 0 } };
  private _running: RunningTimeout | undefined;

  interrupt() {
    if (this._running)
      this._updateTimeout(this._running, -1);
  }

  isRunningCustomTimeSlot() {
    return this._running && this._running.slot !== this._defaultSlot;
  }

  updateCurrentSlotTimeout(timeout: number) {
    if (!this._running) {
      this._defaultSlot.timeoutData.timeout = timeout;
      return;
    }
    this._updateTimeout(this._running, 0);
    if (this._running.slot.timeoutData === 'shared')
      this._running.slot.timeoutData = { timeout: 0, elapsed: 0 };
    this._running.slot.timeoutData.timeout = timeout;
    this._updateTimeout(this._running, undefined);
  }

  updateDefaultTimeout(timeout: number) {
    if (this.isRunningCustomTimeSlot())
      this._defaultSlot.timeoutData.timeout = timeout;
    else
      this.updateCurrentSlotTimeout(timeout);
  }

  resetDefaultTimeout(timeout: number) {
    this._defaultSlot.timeoutData.elapsed = 0;
    this.updateDefaultTimeout(timeout);
  }

  async run<T>(cb: () => Promise<T>, timeSlot?: TimeSlot): Promise<T> {
    const running = this._running = {
      start: monotonicTime(),
      timer: undefined,
      timeoutPromise: new ManualPromise(),
      slot: timeSlot || this._defaultSlot,
    };
    try {
      const resultPromise = Promise.race([
        cb(),
        running.timeoutPromise
      ]);
      this._updateTimeout(running, undefined);
      return await resultPromise;
    } finally {
      this._updateTimeout(running, 0);
      if (this._running === running)
        this._running = undefined;
    }
  }

  private _updateTimeout(running: RunningTimeout, timeout: number | undefined) {
    // Clear timer.
    if (running.timer) {
      clearTimeout(running.timer);
      running.timer = undefined;
    }

    // Update elapsed.
    const timeoutData = running.slot.timeoutData === 'shared' ? this._defaultSlot.timeoutData : running.slot.timeoutData;
    const now = monotonicTime();
    timeoutData.elapsed += now - running.start;
    running.start = now;

    // Determine timeout.
    if (timeout === undefined)
      timeout = timeoutData.timeout;
    if (timeout === 0)
      return;
    timeout = timeout - timeoutData.elapsed;

    // Setup timer.
    if (timeout <= 0)
      running.timeoutPromise.reject(new TimeoutRunnerError());
    else
      running.timer = setTimeout(() => running.timeoutPromise.reject(new TimeoutRunnerError()), timeout);
  }
}
