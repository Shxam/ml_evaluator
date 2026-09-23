import { EXIT_CODES, ExitCode } from '../../core/constants';
import { isCampaignInitialized } from '../../core/storage/layout';
import { withCampaignLock, LockContentionError } from '../../core/concurrency/lock';
import { computeCampaignScores, formatDeterministicScores, IncompleteCampaignError } from '../../core/scoring/scorer';

export function handleScore(cwd: string = process.cwd()): ExitCode {
  if (!isCampaignInitialized(cwd)) {
    process.stderr.write('Error: Campaign is not initialized in this directory. Run "evalcampaign init" first.\n');
    return EXIT_CODES.USAGE_ERROR;
  }

  try {
    return withCampaignLock(() => {
      try {
        const report = computeCampaignScores(cwd);
        const json = formatDeterministicScores(report);
        process.stdout.write(json);
        return EXIT_CODES.SUCCESS;
      } catch (err) {
        if (err instanceof IncompleteCampaignError) {
          process.stderr.write(`Error: ${err.message}\n`);
          return EXIT_CODES.INVALID_STATE;
        }
        process.stderr.write(`Error scoring campaign: ${(err as Error).message}\n`);
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
