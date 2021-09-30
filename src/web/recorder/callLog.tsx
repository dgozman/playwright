/*
  Copyright (c) Microsoft Corporation.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import './callLog.css';
import * as React from 'react';
import type { CallLog, CallLogStatus } from '../../server/supplements/recorder/recorderTypes';
import { msToString } from '../uiUtils';

export interface CallLogProps {
  log: CallLog[],
}

const kCallStatusPriority: CallLogStatus[] = ['paused', 'error', 'in-progress', 'done'];
function mergeCallLogs(call1: CallLog, call2: CallLog): CallLog {
  const statusIndex = Math.min(kCallStatusPriority.indexOf(call1.status), kCallStatusPriority.indexOf(call2.status));
  const duration = (call1.duration === undefined || call2.duration === undefined) ? undefined : call1.duration + call2.duration;
  return {
    id: call1.id,
    apiId: call1.apiId,
    title: call1.title,
    messages: [...call1.messages, ...call2.messages],
    status: kCallStatusPriority[statusIndex],
    reveal: call1.reveal || call2.reveal,
    duration,
    params: call1.params,
  };
}

export const CallLogView: React.FC<CallLogProps> = ({
  log: unmergedLog,
}) => {
  const messagesEndRef = React.createRef<HTMLDivElement>();
  const [expandOverrides, setExpandOverrides] = React.useState<Map<string, boolean>>(new Map());

  const log = React.useMemo(() => {
    // Merge call logs with the same api id into a single visual entry.
    const result = new Map<string, CallLog>();
    for (const log of unmergedLog) {
      const key = log.apiId || log.id;
      const existing = result.get(key);
      result.set(key, existing ? mergeCallLogs(existing, log) : log);
    }
    return Array.from(result.values());
  }, [unmergedLog]);

  React.useLayoutEffect(() => {
    if (log.find(callLog => callLog.reveal))
      messagesEndRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [messagesEndRef, log]);
  return <div className='call-log' style={{ flex: 'auto' }}>
    {log.map(callLog => {
      const expandOverride = expandOverrides.get(callLog.id);
      const isExpanded = typeof expandOverride === 'boolean' ? expandOverride : callLog.status !== 'done';
      return <div className={`call-log-call ${callLog.status}`} key={callLog.id}>
        <div className='call-log-call-header'>
          <span className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`} style={{ cursor: 'pointer' }}onClick={() => {
            const newOverrides = new Map(expandOverrides);
            newOverrides.set(callLog.id, !isExpanded);
            setExpandOverrides(newOverrides);
          }}></span>
          { callLog.title }
          { callLog.params.url ? <span className='call-log-details'>(<span className='call-log-url' title={callLog.params.url}>{callLog.params.url}</span>)</span> : undefined }
          { callLog.params.selector ? <span className='call-log-details'>(<span className='call-log-selector' title={callLog.params.selector}>{callLog.params.selector}</span>)</span> : undefined }
          <span className={'codicon ' + iconClass(callLog)}></span>
          { typeof callLog.duration === 'number' ? <span className='call-log-time'>— {msToString(callLog.duration)}</span> : undefined}
        </div>
        { (isExpanded ? callLog.messages : []).map((message, i) => {
          return <div className='call-log-message' key={i}>
            { message.trim() }
          </div>;
        })}
        { !!callLog.error && <div className='call-log-message error' hidden={!isExpanded}>{ callLog.error.error?.message }</div> }
      </div>;
    })}
    <div ref={messagesEndRef}></div>
  </div>;
};

function iconClass(callLog: CallLog): string {
  switch (callLog.status) {
    case 'done': return 'codicon-check';
    case 'in-progress': return 'codicon-clock';
    case 'paused': return 'codicon-debug-pause';
    case 'error': return 'codicon-error';
  }
}
