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

import type { FrameSnapshot, ResourceSnapshot } from '@trace/snapshot';
import { rewriteURLForCustomProtocol } from './snapshotRenderer';

export class SnapshotStorage {
  private _resources: ResourceSnapshot[] = [];
  private _frameSnapshots = new Map<string, FrameSnapshot[]>();

  addResource(resource: ResourceSnapshot): void {
    resource.request.url = rewriteURLForCustomProtocol(resource.request.url);
    this._resources.push(resource);
  }

  addFrameSnapshot(snapshot: FrameSnapshot) {
    for (const override of snapshot.resourceOverrides)
      override.url = rewriteURLForCustomProtocol(override.url);
    let frameSnapshots = this._frameSnapshots.get(snapshot.frameId);
    if (!frameSnapshots) {
      frameSnapshots = [];
      this._frameSnapshots.set(snapshot.frameId, frameSnapshots);
      if (snapshot.isMainFrame)
        this._frameSnapshots.set(snapshot.pageId, frameSnapshots);
    }
    frameSnapshots.push(snapshot);
    return snapshot;
  }

  snapshotByName(pageOrFrameId: string, snapshotName: string): FrameSnapshot | undefined {
    const snapshot = this._frameSnapshots.get(pageOrFrameId);
    return snapshot?.find(r => r.snapshotName === snapshotName);
  }

  snapshotsForFrame(pageOrFrameId: string) {
    return this._frameSnapshots.get(pageOrFrameId) || [];
  }

  resourceByUrl(snapshot: FrameSnapshot, url: string, method: string): ResourceSnapshot | undefined {
    let sameFrameResource: ResourceSnapshot | undefined;
    let otherFrameResource: ResourceSnapshot | undefined;

    for (const resource of this._resources) {
      // Only use resources that received response before the snapshot.
      // Note that both snapshot time and request time are taken in the same Node process.
      if (typeof resource._monotonicTime === 'number' && resource._monotonicTime >= snapshot.timestamp)
        break;
      if (resource.response.status === 304) {
        // "Not Modified" responses are issued when browser requests the same resource
        // multiple times, meanwhile indicating that it has the response cached.
        //
        // When rendering the snapshot, browser most likely will not have the resource cached,
        // so we should respond with the real content instead, picking the last response that
        // is not 304.
        continue;
      }
      if (resource.request.url === url && resource.request.method === method) {
        // Pick the last resource with matching url - most likely it was used
        // at the time of snapshot, not the earlier aborted resource with the same url.
        if (resource._frameref === snapshot.frameId)
          sameFrameResource = resource;
        else
          otherFrameResource = resource;
      }
    }

    // First try locating exact resource belonging to this frame,
    // then fall back to resource with this URL to account for memory cache.
    let result = sameFrameResource ?? otherFrameResource;
    if (result && method.toUpperCase() === 'GET') {
      // Patch override if necessary.
      for (const o of snapshot.resourceOverrides) {
        if (url === o.url && o.sha1) {
          result = {
            ...result,
            response: {
              ...result.response,
              content: {
                ...result.response.content,
                _sha1: o.sha1,
              }
            },
          };
          break;
        }
      }
    }

    return result;
  }

  snapshotByTime(pageOrFrameId: string, snapshotTime: number): FrameSnapshot | undefined {
    let result: FrameSnapshot | undefined;
    for (const snapshot of this._frameSnapshots.get(pageOrFrameId) || []) {
      const timestamp = snapshot.timestamp;
      if (timestamp <= snapshotTime && (!result || result.timestamp < timestamp))
        result = snapshot;
    }
    return result;
  }

  snapshotsForTest() {
    return [...this._frameSnapshots.keys()];
  }

  finalize() {
    // Resources are not necessarily sorted in the trace file, so sort them now.
    this._resources.sort((a, b) => (a._monotonicTime || 0) - (b._monotonicTime || 0));
  }
}
