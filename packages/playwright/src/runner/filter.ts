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

import path from 'path';
import sourceMapSupport from 'source-map-support';

import { loadTestList } from './loadUtils';
import { filterProjects } from './projectUtils';
import { detectChangedTestFiles } from './vcs';
import { createTitleMatcher, forceRegExp } from '../util';
import { createFiltersFromArguments, filterTestsRemoveEmptySuites } from '../common/suiteUtils';
import { Suite } from '../common/test';

import type { FullConfigInternal, FullProjectInternal } from '../common/config';
import type { RawSourceMap } from 'playwright-core/lib/utilsBundle';
import type { Matcher, TestCaseFilter } from '../util';

export type FilterOptions = {
  locations?: string[];
  grep?: string;
  grepInvert?: string;
  onlyChanged?: string;
  projectFilter?: string[];
  passWithNoTests?: boolean;
  lastFailed?: boolean;
  lastFailedTestIds?: string[];
  testIds?: string[];
  testList?: string;
  testListInvert?: string;
};

export class Filter {
  readonly filteredProjects: FullProjectInternal[];
  private readonly _options: FilterOptions;
  private readonly _fileFilters: Matcher[] = [];
  private readonly _preOnlyTestFilters: TestCaseFilter[] = [];
  private readonly _postShardTestFilters: TestCaseFilter[] = [];
  private readonly _sourceMapCache = new Map<string, string[]>();

  constructor(config: FullConfigInternal, options: FilterOptions) {
    this._options = options;
    this.filteredProjects = filterProjects(config.projects, options.projectFilter);
  }

  async loadFileFilters(config: FullConfigInternal) {
    const options = this._options;
    if (options.locations?.length) {
      const { testFilter, fileFilter } = createFiltersFromArguments(options.locations);
      this._fileFilters.push(fileFilter);
      this._preOnlyTestFilters.push(testFilter);
    }

    if (options.testList) {
      const { testFilter, fileFilter } = await loadTestList(config, options.testList);
      this._preOnlyTestFilters.push(testFilter);
      this._fileFilters.push(fileFilter);
    }
  }

  async loadTestFilters(config: FullConfigInternal) {
    const options = this._options;

    if (options.testListInvert) {
      // Note: invert list does not mean we can filter files. For example, the following invert list
      // can still run tests from foo.spec.ts:
      //
      // foo.spec.ts > some test
      const { testFilter } = await loadTestList(config, options.testListInvert);
      this._preOnlyTestFilters.push(test => !testFilter(test));
    }

    if (options.grep || options.grepInvert) {
      const grepMatcher = options.grep ? createTitleMatcher(forceRegExp(options.grep)) : () => true;
      const grepInvertMatcher = options.grepInvert ? createTitleMatcher(forceRegExp(options.grepInvert)) : () => false;
      this._preOnlyTestFilters.push(test => {
        const grepTitle = test._grepTitleWithTags();
        return !grepInvertMatcher(grepTitle) && grepMatcher(grepTitle);
      });
    }

    if (options.testIds?.length) {
      const testIdSet = new Set<string>(options.testIds);
      this._preOnlyTestFilters.push(test => testIdSet.has(test.id));
    }

    if (options.onlyChanged) {
      const changedFiles = await detectChangedTestFiles(options.onlyChanged, config.configDir);
      this._preOnlyTestFilters.push(test => changedFiles.has(test.location.file));
    }

    if (options.lastFailedTestIds) {
      const lastFailedTestIdSet = new Set(options.lastFailedTestIds);
      this._postShardTestFilters.push(test => lastFailedTestIdSet.has(test.id));
    }
  }

  filterFiles(files: string[]): string[] {
    if (!this._fileFilters.length)
      return files;
    return files.filter(file => {
      return sourceMapSources(file, this._sourceMapCache).some(source => this._fileFilters.every(f => f(source)));
    });
  }

  filterProjectSuiteBeforeOnly(projectSuite: Suite): Suite {
    if (!this._preOnlyTestFilters.length)
      return projectSuite;
    const result = projectSuite._deepClone();
    filterTestsRemoveEmptySuites(result, test => this._preOnlyTestFilters.every(f => f(test)));
    return result;
  }

  filterRootSuitePostShard(rootSuite: Suite) {
    this._sourceMapCache.clear();
    if (this._postShardTestFilters.length)
      filterTestsRemoveEmptySuites(rootSuite, test => this._postShardTestFilters.every(f => f(test)));
  }

  throwIfNoTestsFound() {
    if (this._options.passWithNoTests || this._options.onlyChanged
        || this._options.testList || this._options.testListInvert)
      return;
    if (this._options.locations?.length) {
      throw new Error([
        `No tests found.`,
        `Make sure that arguments are regular expressions matching test files.`,
        `You may need to escape symbols like "$" or "*" and quote the arguments.`,
      ].join('\n'));
    }
    throw new Error(`No tests found`);
  }
}

function sourceMapSources(file: string, cache: Map<string, string[]>): string[] {
  let sources = [file];
  if (!file.endsWith('.js'))
    return sources;
  if (cache.has(file))
    return cache.get(file)!;

  try {
    const sourceMap = sourceMapSupport.retrieveSourceMap(file);
    const sourceMapData: RawSourceMap | undefined = typeof sourceMap?.map === 'string' ? JSON.parse(sourceMap.map) : sourceMap?.map;
    if (sourceMapData?.sources)
      sources = sourceMapData.sources.map(source => path.resolve(path.dirname(file), source));
  } finally {
    cache.set(file, sources);
    return sources;
  }
}
