import { EXIT_CODES, ExitCode } from '../core/constants';
import { handleInit } from './commands/init';
import { handleAddTask } from './commands/addTask';
import { handleAddModel } from './commands/addModel';
import { handleRun } from './commands/run';
import { handleResume } from './commands/resume';
import { handleStatus } from './commands/status';
import { handleScore } from './commands/score';
import { handleRegisterPut } from './commands/registerPut';
import { handleRegisterGet } from './commands/registerGet';
import { handleRollback } from './commands/rollback';
import { handleExport } from './commands/export';

export function runCli(argv: string[], cwd: string = process.cwd()): ExitCode | Promise<ExitCode> {
  const args = argv.slice(2);

  if (args.length === 0) {
    process.stderr.write(
      'Usage: evalcampaign <command> [options]\n\n' +
      'Available commands:\n' +
      '  init <campaign_json_path>             Initialize a new evaluation campaign\n' +
      '  add-task <task_json_path>             Register a task specification\n' +
      '  add-model <model_json_path>           Register a model definition\n' +
      '  run                                   Execute scheduled evaluation campaign\n' +
      '  resume                                Resume an interrupted or incomplete campaign\n' +
      '  status [--json]                       Display campaign execution status\n' +
      '  score                                 Compute and display aggregate model scores\n' +
      '  register-put --reg <name> <file_path> Store artifact in named scratch register\n' +
      '  register-get --reg <name>             Stream content of named scratch register\n' +
      '  rollback [n]                          Revert campaign state by n completed batches\n' +
      '  export --format json                  Emit deterministic evaluation report\n'
    );
    return EXIT_CODES.USAGE_ERROR;
  }

  const command = args[0];

  switch (command) {
    case 'init': {
      const configPath = args[1];
      return handleInit(configPath, cwd);
    }
    case 'add-task': {
      const taskPath = args[1];
      return handleAddTask(taskPath, cwd);
    }
    case 'add-model': {
      const modelPath = args[1];
      return handleAddModel(modelPath, cwd);
    }
    case 'run': {
      return handleRun(cwd);
    }
    case 'resume': {
      return handleResume(cwd);
    }
    case 'status': {
      const rest = args.slice(1);
      let json = false;
      for (const arg of rest) {
        if (arg === '--json') {
          json = true;
        } else {
          process.stderr.write(`Error: Unknown option "${arg}". Usage: evalcampaign status [--json]\n`);
          return EXIT_CODES.USAGE_ERROR;
        }
      }
      return handleStatus({ json }, cwd);
    }
    case 'score': {
      return handleScore(cwd);
    }
    case 'register-put': {
      return handleRegisterPut(args.slice(1), cwd);
    }
    case 'register-get': {
      return handleRegisterGet(args.slice(1), cwd);
    }
    case 'rollback': {
      return handleRollback(args.slice(1), cwd);
    }
    case 'export': {
      return handleExport(args.slice(1), cwd);
    }
    default: {
      process.stderr.write(`Error: Unknown command "${command}".\n`);
      return EXIT_CODES.USAGE_ERROR;
    }
  }
}
