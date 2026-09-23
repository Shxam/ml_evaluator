import { spawn, spawnSync, ChildProcess } from 'child_process';
import { SubprocessExecutionResult } from './types';

export interface DriverRunParams {
  command: string;
  taskId: string;
  modelId: string;
  repetition: number;
  attempt: number;
  timeoutSeconds: number;
  maxOutputBytes: number;
  cwd?: string;
}

/**
 * Executes a task evaluator command as a child process with environment protocol,
 * timeout enforcement, and output bounding.
 */
export async function executeEvaluator(params: DriverRunParams): Promise<SubprocessExecutionResult> {
  const {
    command,
    taskId,
    modelId,
    repetition,
    attempt,
    timeoutSeconds,
    maxOutputBytes,
    cwd = process.cwd()
  } = params;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EVAL_TASK_ID: String(taskId),
    EVAL_MODEL_ID: String(modelId),
    EVAL_REPETITION: String(repetition),
    EVAL_ATTEMPT: String(attempt)
  };

  return new Promise((resolve) => {
    const startTime = Date.now();
    let timedOut = false;
    let outputOverflow = false;
    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];
    let totalOutputBytes = 0;
    let resolved = false;

    const child: ChildProcess = spawn(command, {
      shell: true,
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const killChild = () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t']);
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    };

    let timeoutTimer: NodeJS.Timeout | null = null;
    if (timeoutSeconds > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killChild();
      }, timeoutSeconds * 1000);
    }

    const checkOutputOverflow = (chunk: Buffer, isStdout: boolean) => {
      totalOutputBytes += chunk.length;
      if (totalOutputBytes > maxOutputBytes && !outputOverflow) {
        outputOverflow = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        killChild();
      }

      if (isStdout) {
        stdoutChunks.push(chunk);
      } else {
        stderrChunks.push(chunk);
      }
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        checkOutputOverflow(chunk, true);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        checkOutputOverflow(chunk, false);
      });
    }

    const finish = (exitCode: number | null) => {
      if (resolved) return;
      resolved = true;

      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }

      const executionTimeMs = Date.now() - startTime;
      let stdoutBuffer = Buffer.concat(stdoutChunks);
      let stderrBuffer = Buffer.concat(stderrChunks);

      // If output overflowed, truncate stored buffers to maxOutputBytes
      if (outputOverflow) {
        if (stdoutBuffer.length > maxOutputBytes) {
          stdoutBuffer = stdoutBuffer.subarray(0, maxOutputBytes);
        }
        if (stderrBuffer.length > maxOutputBytes) {
          stderrBuffer = stderrBuffer.subarray(0, maxOutputBytes);
        }
      }

      resolve({
        exitCode: (timedOut || outputOverflow) ? null : exitCode,
        stdout: stdoutBuffer.toString('utf8'),
        stderr: stderrBuffer.toString('utf8'),
        executionTimeMs,
        timedOut,
        outputOverflow
      });
    };

    child.on('error', (_err) => {
      finish(1);
    });

    child.on('close', (code) => {
      finish(code);
    });
  });
}
