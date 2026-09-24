#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildGroundTruthSources } from '../tests/fixtures/import-ground-truth.ts';
import {
  evaluateImportGroundTruth,
  parseProviderOutput,
} from '../tests/fixtures/import-ground-truth-evaluator.ts';

const usage = `Usage:
  node scripts/import-ground-truth.ts create /absolute/output/directory
  node scripts/import-ground-truth.ts grade /absolute/provider-output.jsonl [--stage proposal|accepted|both] [--asset-bindings /absolute/source-ids.json] [--min-score 1]

create writes fictional PDF/ZIP source files and a byte manifest outside the repository.
grade only reads the supplied local output. It does not import, accept, copy, or retain that file.
Optional source-ids.json maps pdf, zipCopy, optical, and scan to retained source IDs.`;

function argument(name: string, fallback: string | null) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function fail(message: string) {
  process.stderr.write(message + '\n\n' + usage + '\n');
  process.exitCode = 2;
}

const [, , command, target] = process.argv;

if (command === 'create' && target) {
  const created = buildGroundTruthSources(resolve(target));
  process.stdout.write(
    JSON.stringify(
      {
        fixture: created.manifest.fixture,
        directory: created.directory,
        files: created.manifest.files,
        zipMembers: created.manifest.zipMembers,
      },
      null,
      2,
    ) + '\n',
  );
} else if (command === 'grade' && target) {
  const stage = argument('--stage', 'proposal');
  const minimum = Number(argument('--min-score', '1'));
  if (!['proposal', 'accepted', 'both'].includes(stage!))
    fail('--stage must be proposal, accepted, or both');
  else if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1)
    fail('--min-score must be a number from 0 through 1');
  else {
    try {
      const actual = parseProviderOutput(readFileSync(resolve(target), 'utf8'));
      const bindingsPath = argument('--asset-bindings', null);
      const assetBindings = bindingsPath
        ? JSON.parse(readFileSync(resolve(bindingsPath), 'utf8'))
        : undefined;
      const report =
        stage === 'both'
          ? {
              proposal: evaluateImportGroundTruth(actual, {
                stage: 'proposal',
                assetBindings,
              }),
              accepted: evaluateImportGroundTruth(actual, { stage: 'accepted', assetBindings }),
            }
          : evaluateImportGroundTruth(actual, {
              stage: stage as 'proposal' | 'accepted',
              assetBindings,
            });
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      const reports = (stage === 'both' ? Object.values(report) : [report]) as Array<
        ReturnType<typeof evaluateImportGroundTruth>
      >;
      if (reports.some((value) => !value.passed || value.score < minimum)) process.exitCode = 1;
    } catch (error) {
      fail((error as Error).message);
    }
  }
} else {
  fail('Choose create or grade and supply an absolute path');
}
