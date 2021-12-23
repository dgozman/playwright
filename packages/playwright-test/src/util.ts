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

import util from 'util';
import path from 'path';
import url from 'url';
import type { TestError, Location } from './types';
import { default as minimatch } from 'minimatch';
import debug from 'debug';
import { calculateSha1, isRegExp } from 'playwright-core/lib/utils/utils';
import StackUtils from 'stack-utils';

const stackUtils = new StackUtils({ cwd: '__impossible__directory__to__force__absolute__paths__' });

interface ErrorWithLocation extends Error {
  location: Location;
}

export function serializeError(error: Error | any, forceLocation?: boolean): TestError {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      location: determineErrorLocation(error, !!forceLocation),
    };
  }
  return {
    value: util.inspect(error)
  };
}

function determineErrorLocation(error: Error, force: boolean) {
  if ((error as ErrorWithLocation).location)
    return (error as ErrorWithLocation).location;
  if (!force)
    return;
  const lines = (error.stack || '').split('\n');
  const firstStackLine = lines.find(line => line.startsWith('    at '));
  const parsed = firstStackLine === undefined ? null : stackUtils.parseLine(firstStackLine);
  if (!parsed || !parsed.file)
    return;
  return { file: parsed.file, line: parsed.line || 0, column: parsed.column || 0 };
}

export function serializeErrorWithLocation(error: Error | any): TestError {
  return serializeError(error, true);
}

export function monotonicTime(): number {
  const [seconds, nanoseconds] = process.hrtime();
  return seconds * 1000 + (nanoseconds / 1000000 | 0);
}

export type Matcher = (value: string) => boolean;

export type FilePatternFilter = {
  re: RegExp;
  line: number | null;
};

export function createFileMatcher(patterns: string | RegExp | (string | RegExp)[]): Matcher {
  const reList: RegExp[] = [];
  const filePatterns: string[] = [];
  for (const pattern of Array.isArray(patterns) ? patterns : [patterns]) {
    if (isRegExp(pattern)) {
      reList.push(pattern);
    } else {
      if (!pattern.startsWith('**/') && !pattern.startsWith('**/'))
        filePatterns.push('**/' + pattern);
      else
        filePatterns.push(pattern);
    }
  }
  return (filePath: string) => {
    for (const re of reList) {
      re.lastIndex = 0;
      if (re.test(filePath))
        return true;
    }
    // Windows might still recieve unix style paths from Cygwin or Git Bash.
    // Check against the file url as well.
    if (path.sep === '\\') {
      const fileURL = url.pathToFileURL(filePath).href;
      for (const re of reList) {
        re.lastIndex = 0;
        if (re.test(fileURL))
          return true;
      }
    }
    for (const pattern of filePatterns) {
      if (minimatch(filePath, pattern, { nocase: true, dot: true }))
        return true;
    }
    return false;
  };
}

export function createTitleMatcher(patterns: RegExp | RegExp[]): Matcher {
  const reList = Array.isArray(patterns) ? patterns : [patterns];
  return (value: string) => {
    for (const re of reList) {
      re.lastIndex = 0;
      if (re.test(value))
        return true;
    }
    return false;
  };
}

export function mergeObjects<A extends object, B extends object>(a: A | undefined | void, b: B | undefined | void): A & B {
  const result = { ...a } as any;
  if (!Object.is(b, undefined)) {
    for (const [name, value] of Object.entries(b as B)) {
      if (!Object.is(value, undefined))
        result[name] = value;
    }
  }
  return result as any;
}

export async function wrapInPromise(value: any) {
  return value;
}

export function forceRegExp(pattern: string): RegExp {
  const match = pattern.match(/^\/(.*)\/([gi]*)$/);
  if (match)
    return new RegExp(match[1], match[2]);
  return new RegExp(pattern, 'g');
}

function relativeFilePath(file: string): string {
  if (!path.isAbsolute(file))
    return file;
  return path.relative(process.cwd(), file);
}

export function formatLocation(location: Location) {
  return relativeFilePath(location.file) + ':' + location.line + ':' + location.column;
}

export function errorWithFile(file: string, message: string) {
  return new Error(`${relativeFilePath(file)}: ${message}`);
}

export function errorWithLocation(location: Location, message: string) {
  const e = new Error(message);
  (e as ErrorWithLocation).location = location;
  return e;
}

export function expectType(receiver: any, type: string, matcherName: string) {
  if (typeof receiver !== 'object' || receiver.constructor.name !== type)
    throw new Error(`${matcherName} can be only used with ${type} object`);
}

export function sanitizeForFilePath(s: string) {
  return s.replace(/[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, '-');
}

export function trimLongString(s: string, length = 100) {
  if (s.length <= length)
    return s;
  const hash = calculateSha1(s);
  const middle = `-${hash.substring(0, 5)}-`;
  const start = Math.floor((length - middle.length) / 2);
  const end = length - middle.length - start;
  return s.substring(0, start) + middle + s.slice(-end);
}

export function addSuffixToFilePath(filePath: string, suffix: string, customExtension?: string, sanitize = false): string {
  const dirname = path.dirname(filePath);
  const ext = path.extname(filePath);
  const name = path.basename(filePath, ext);
  const base = path.join(dirname, name);
  return (sanitize ? sanitizeForFilePath(base) : base) + suffix + (customExtension || ext);
}

/**
 * Returns absolute path contained within parent directory.
 */
export function getContainedPath(parentPath: string, subPath: string = ''): string | null {
  const resolvedPath = path.resolve(parentPath, subPath);
  if (resolvedPath === parentPath || resolvedPath.startsWith(parentPath + path.sep)) return resolvedPath;
  return null;
}

export const debugTest = debug('pw:test');

export function prependToTestError(testError: TestError | undefined, message: string | undefined, location?: Location) {
  if (!message)
    return testError;
  if (!testError)
    return { value: message.endsWith('\n') ? message.substring(0, message.length - 1) : message, location };
  if (testError.message) {
    const stack = testError.stack ? message + testError.stack : testError.stack;
    message = message + testError.message;
    return {
      value: testError.value,
      message,
      stack,
    };
  }
  return testError;
}
