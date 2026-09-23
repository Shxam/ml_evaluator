import { EXIT_CODES, ExitCode } from '../../core/constants';
import { isCampaignInitialized } from '../../core/storage/layout';
import { withCampaignLock, LockContentionError } from '../../core/concurrency/lock';
import { generateCampaignExport, formatDeterministicExport, ExportError } from '../../core/export/exporter';
import { ProvenanceDriftError } from '../../core/provenance/provenance';
import { UnrecoverableCorruptionError } from '../../core/execution/recovery';

export function handleExport(args: string[], cwd: string = process.cwd()): ExitCode {
  if (!isCampaignInitialized(cwd)) {
    process.stderr.write('Error: Campaign is not initialized in this directory. Run "evalcampaign init" first.\n');
    return EXIT_CODES.USAGE_ERROR;
  }

  let format: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--format') {
      format = args[++i];
    } else if (arg.startsWith('--format=')) {
      format = arg.slice('--format='.length);
    }
  }

  if (format !== 'json') {
    process.stderr.write('Error: Unsupported or missing export format. Usage: evalcampaign export --format json\n');
    return EXIT_CODES.USAGE_ERROR;
  }

  try {
    return withCampaignLock(() => {
      try {
        const report = generateCampaignExport(cwd);
        const json = formatDeterministicExport(report);
        process.stdout.write(json);
        return EXIT_CODES.SUCCESS;
      } catch (err) {
        if (err instanceof ProvenanceDriftError) {
          process.stderr.write(`Error: ${err.message}\n`);
          return EXIT_CODES.PROVENANCE_DRIFT;
        }
        if (err instanceof UnrecoverableCorruptionError) {
          process.stderr.write(`Error: ${err.message}\n`);
          return EXIT_CODES.UNRECOVERABLE_CORRUPTION;
        }
        if (err instanceof ExportError) {
          process.stderr.write(`Error: ${err.message}\n`);
          return err.exitCode;
        }
        process.stderr.write(`Error exporting campaign: ${(err as Error).message}\n`);
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
