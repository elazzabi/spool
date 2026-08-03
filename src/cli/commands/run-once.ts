import type { SpoolConfig } from '../../config/schema.js';
import { openSpoolRuntime, runUntilConverged } from '../../scheduler/service.js';
import { sanitizeTerminalText, type StaticCliPresenter } from '../output.js';

export interface RunOnceReport {
  passes: number;
  claimed: number;
  launched: number;
  projected: number;
  blockedProjections: number;
  warnings: string[];
}

export async function runOnce(config: SpoolConfig): Promise<RunOnceReport> {
  const runtime = await openSpoolRuntime(config, { mode: 'run-once' });
  let outcome: 'clean' | 'failed' = 'failed';
  let results;
  try {
    results = await runUntilConverged(runtime.reconciler);
    outcome = 'clean';
  } finally {
    await runtime.close(outcome);
  }
  return {
    passes: results.length,
    claimed: results.reduce((count, result) => count + result.claimedJobIds.length, 0),
    launched: results.reduce(
      (count, result) =>
        count +
        result.dispatches.reduce((dispatchCount, item) => dispatchCount + item.launched.length, 0),
      0,
    ),
    projected: results.reduce((count, result) => count + result.projected, 0),
    blockedProjections: results.reduce((count, result) => count + result.blockedProjections, 0),
    warnings: [
      ...new Set([...runtime.warnings, ...results.flatMap((result) => result.diagnostics)]),
    ],
  };
}

export function presentRunOnceReport(report: RunOnceReport, presenter: StaticCliPresenter): void {
  presenter.intro('spool reconciliation');
  presenter.section('Summary', summaryLines(report));
  for (const warning of report.warnings) {
    presenter.warn(sanitizeTerminalText(warning));
  }
  presenter.outro('Reconciliation complete');
}

function summaryLines(report: RunOnceReport): string[] {
  return [
    `Passes: ${String(report.passes)}`,
    `Claimed jobs: ${String(report.claimed)}`,
    `Launched attempts: ${String(report.launched)}`,
    `Applied projections: ${String(report.projected)}`,
    `Blocked projections: ${String(report.blockedProjections)}`,
  ];
}
