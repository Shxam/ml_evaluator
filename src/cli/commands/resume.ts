import { ExitCode } from '../../core/constants';
import { resumeCampaign } from '../../core/execution/resumer';

export async function handleResume(cwd: string = process.cwd()): Promise<ExitCode> {
  const result = await resumeCampaign(cwd);
  return result.exitCode;
}
