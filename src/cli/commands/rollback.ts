import { EXIT_CODES, ExitCode } from '../../core/constants';
import { isCampaignInitialized } from '../../core/storage/layout';
import { withCampaignLock, LockContentionError } from '../../core/concurrency/lock';
import { rollbackCampaign, RollbackError } from '../../core/rollback/rollback';

export function handleRollback(args: string[], cwd: string = process.cwd()): ExitCode {
  if (!isCampaignInitialized(cwd)) {
    process.stderr.write('Error: Campaign is not initialized in this directory. Run "evalcampaign init" first.\n');
    return EXIT_CODES.USAGE_ERROR;
  }

  let n = 1;
  if (args.length > 0) {
    const rawN = args[0];
    if (!/^\d+$/.test(rawN)) {
      process.stderr.write(`Error: Invalid rollback count "${rawN}". Must be a positive integer.\n`);
      return EXIT_CODES.USAGE_ERROR;
    }
    n = parseInt(rawN, 10);
    if (n < 1) {
      process.stderr.write(`Error: Rollback count must be >= 1. Received "${n}".\n`);
      return EXIT_CODES.USAGE_ERROR;
    }
  }

  try {
    return withCampaignLock(() => {
      try {
        const result = rollbackCampaign(n, cwd);
        process.stdout.write(
          `Reverted campaign by ${result.revertedBatches} batch(es). ` +
          `${result.remainingCompletedRuns} / ${result.totalLogicalRuns} completed runs remain.\n`
        );
        return EXIT_CODES.SUCCESS;
      } catch (err) {
        if (err instanceof RollbackError) {
          process.stderr.write(`Error: ${err.message}\n`);
          return err.exitCode;
        }
        process.stderr.write(`Error during rollback: ${(err as Error).message}\n`);
        return EXIT_CODES.INVALID_STATE;
      }
    }, cwd);
  } catch (err) {
    if (err instanceof LockContentionError) {
      process.stderr.write(`Error: ${err.message}\n`);
      return EXIT_CODES.LOCK_CONTENTION;
    }
    process.stderr.write(`Unexpected error: ${(err as Error).message}\n`);
    return EXIT_CODES.INVALID_STATE;
  }
}
