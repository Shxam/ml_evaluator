import { EXIT_CODES, ExitCode } from '../../core/constants';
import { isCampaignInitialized } from '../../core/storage/layout';
import { withCampaignLock, LockContentionError } from '../../core/concurrency/lock';
import { getCampaignStatus, formatPlaintextStatus, formatJsonStatus } from '../../core/status/status';

export interface StatusOptions {
  json?: boolean;
}

export function handleStatus(options: StatusOptions = {}, cwd: string = process.cwd()): ExitCode {
  if (!isCampaignInitialized(cwd)) {
    process.stderr.write('Error: Campaign is not initialized in this directory. Run "evalcampaign init" first.\n');
    return EXIT_CODES.USAGE_ERROR;
  }

  try {
    return withCampaignLock(() => {
      try {
        const status = getCampaignStatus(cwd);
        if (options.json) {
          process.stdout.write(formatJsonStatus(status));
        } else {
          process.stdout.write(formatPlaintextStatus(status));
        }
        return EXIT_CODES.SUCCESS;
      } catch (err) {
        process.stderr.write(`Error retrieving campaign status: ${(err as Error).message}\n`);
        return EXIT_CODES.UNRECOVERABLE_CORRUPTION;
      }
    }, cwd);
  } catch (err) {
    if (err instanceof LockContentionError) {
      process.stderr.write(`Error: ${err.message}\n`);
      return EXIT_CODES.LOCK_CONTENTION;
    }
    process.stderr.write(`Unexpected error: ${(err as Error).message}\n`);
    return EXIT_CODES.UNRECOVERABLE_CORRUPTION;
  }
}
