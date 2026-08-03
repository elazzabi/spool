import type { SpoolConfig } from '../../config/schema.js';
import { sanitizeOperatorText } from '../../providers/logs.js';
import { openSpoolRuntime, ReconciliationService } from '../../scheduler/service.js';

export async function runDaemon(config: SpoolConfig): Promise<void> {
  const runtime = await openSpoolRuntime(config, {
    mode: 'daemon',
    onOperationalLogWarning: (warning) =>
      process.stderr.write(`Warning: ${sanitizeOperatorText(warning)}\n`),
  });
  const service = new ReconciliationService({
    config,
    reconciler: runtime.reconciler,
    onDiagnostic: (message) => process.stderr.write(`Warning: ${sanitizeOperatorText(message)}\n`),
  });
  let outcome: 'clean' | 'failed' = 'failed';
  try {
    for (const warning of runtime.warnings) {
      process.stderr.write(`Warning: ${sanitizeOperatorText(warning)}\n`);
    }
    await service.start();
    await waitForShutdownSignal();
    outcome = 'clean';
  } finally {
    try {
      await service.stop(outcome);
    } finally {
      await runtime.close(outcome);
    }
  }
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      resolve();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}
