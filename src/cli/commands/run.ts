import { ExitCode } from '../../core/constants';
import { runCampaign } from '../../core/execution/runner';

export async function handleRun(cwd: string = process.cwd()): Promise<ExitCode> {
  const result = await runCampaign(cwd);
  return result.exitCode;
}
