import * as fs from 'fs';
import * as path from 'path';
import { getCampaignPaths, isCampaignInitialized } from '../storage/layout';
import { EXIT_CODES, ExitCode } from '../constants';

export class RegisterError extends Error {
  public readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode = EXIT_CODES.USAGE_ERROR) {
    super(message);
    this.name = 'RegisterError';
    this.exitCode = exitCode;
  }
}

/**
 * Validates register name according to specification:
 * Must be a single alphanumeric character: ^[a-zA-Z0-9]$
 */
export function validateRegisterName(name: string): boolean {
  if (typeof name !== 'string') return false;
  return /^[a-zA-Z0-9]$/.test(name);
}

/**
 * Atomically stores binary or text data into named scratch register.
 * Stored at: .evalcampaign/registers/reg_<name>.blob
 */
export function putRegister(name: string, sourceFilePath: string, cwd: string = process.cwd()): void {
  if (!isCampaignInitialized(cwd)) {
    throw new RegisterError('Campaign is not initialized in this directory. Run "evalcampaign init" first.', EXIT_CODES.USAGE_ERROR);
  }

  if (!validateRegisterName(name)) {
    throw new RegisterError(`Invalid register name "${name}". Register name must be a single alphanumeric character (^[a-zA-Z0-9]$).`, EXIT_CODES.USAGE_ERROR);
  }

  const resolvedSource = path.isAbsolute(sourceFilePath)
    ? sourceFilePath
    : path.resolve(cwd, sourceFilePath);

  if (!fs.existsSync(resolvedSource)) {
    throw new RegisterError(`Source file for register not found at "${resolvedSource}".`, EXIT_CODES.USAGE_ERROR);
  }

  const paths = getCampaignPaths(cwd);
  if (!fs.existsSync(paths.registersDir)) {
    fs.mkdirSync(paths.registersDir, { recursive: true });
  }

  const targetPath = path.join(paths.registersDir, `reg_${name}.blob`);
  const tempPath = path.join(paths.registersDir, `.reg_${name}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);

  try {
    const data = fs.readFileSync(resolvedSource);
    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
    }
    throw new RegisterError(`Failed to save register: ${(err as Error).message}`, EXIT_CODES.USAGE_ERROR);
  }
}

/**
 * Retrieves raw content of named scratch register as Buffer.
 * Stored at: .evalcampaign/registers/reg_<name>.blob
 */
export function getRegister(name: string, cwd: string = process.cwd()): Buffer {
  if (!isCampaignInitialized(cwd)) {
    throw new RegisterError('Campaign is not initialized in this directory. Run "evalcampaign init" first.', EXIT_CODES.USAGE_ERROR);
  }

  if (!validateRegisterName(name)) {
    throw new RegisterError(`Invalid register name "${name}". Register name must be a single alphanumeric character (^[a-zA-Z0-9]$).`, EXIT_CODES.USAGE_ERROR);
  }

  const paths = getCampaignPaths(cwd);
  const targetPath = path.join(paths.registersDir, `reg_${name}.blob`);

  if (!fs.existsSync(targetPath)) {
    throw new RegisterError(`Register "${name}" not found.`, EXIT_CODES.USAGE_ERROR);
  }

  const stat = fs.statSync(targetPath);
  if (stat.size === 0) {
    throw new RegisterError(`Register "${name}" is empty.`, EXIT_CODES.USAGE_ERROR);
  }

  return fs.readFileSync(targetPath);
}
