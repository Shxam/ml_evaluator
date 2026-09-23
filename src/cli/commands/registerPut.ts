import { EXIT_CODES, ExitCode } from '../../core/constants';
import { isCampaignInitialized } from '../../core/storage/layout';
import { withCampaignLock, LockContentionError } from '../../core/concurrency/lock';
import { putRegister, RegisterError } from '../../core/registers/register';

export function handleRegisterPut(args: string[], cwd: string = process.cwd()): ExitCode {
  if (!isCampaignInitialized(cwd)) {
    process.stderr.write('Error: Campaign is not initialized in this directory. Run "evalcampaign init" first.\n');
    return EXIT_CODES.USAGE_ERROR;
  }

  let regName: string | undefined;
  let filePath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--reg') {
      regName = args[++i];
    } else if (arg.startsWith('--reg=')) {
      regName = arg.slice('--reg='.length);
    } else if (!arg.startsWith('-')) {
      if (!filePath) {
        filePath = arg;
      }
    }
  }

  if (!regName || !filePath) {
    process.stderr.write('Usage: evalcampaign register-put --reg <name> <file_path>\n');
    return EXIT_CODES.USAGE_ERROR;
  }

  const { validateRegisterName } = require('../../core/registers/register');
  if (!validateRegisterName(regName)) {
    process.stderr.write(`Error: Invalid register name "${regName}". Must be a single alphanumeric character (^[a-zA-Z0-9]$).\n`);
    return EXIT_CODES.USAGE_ERROR;
  }

  try {
    return withCampaignLock(() => {
      try {
        putRegister(regName!, filePath!, cwd);
        process.stdout.write(`Register "${regName}" saved successfully.\n`);
        return EXIT_CODES.SUCCESS;
      } catch (err) {
        if (err instanceof RegisterError) {
          process.stderr.write(`Error: ${err.message}\n`);
          return err.exitCode;
        }
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        return EXIT_CODES.USAGE_ERROR;
      }
    }, cwd);
  } catch (err) {
    if (err instanceof LockContentionError) {
      process.stderr.write(`Error: ${err.message}\n`);
      return EXIT_CODES.LOCK_CONTENTION;
    }
    process.stderr.write(`Unexpected error: ${(err as Error).message}\n`);
    return EXIT_CODES.USAGE_ERROR;
  }
}
