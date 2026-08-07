import { inject, injectable } from 'inversify';
import path from 'path';
import type { IDaemonConfigRepository } from '../repositories/daemon-config.repository';
import type { IDaemonProcessRepository } from '../repositories/daemon-process.repository';
import type { ILaunchdRepository } from '../repositories/launchd.repository';
import { WORKFLOW_TOKENS } from '../tokens';
import type { DaemonConfig, DaemonRuntimePaths } from '../types';

export interface DaemonInstallOptions {
  /** Override LaunchAgents directory (tests). */
  plistDir?: string;
  /** When false, write the plist without calling launchctl. Default true. */
  load?: boolean;
  /** Absolute CLI entry to put in ProgramArguments (defaults to require.main). */
  cliEntry?: string;
  /** Executable for ProgramArguments[0] (defaults to process.execPath). */
  program?: string;
}

export interface DaemonInstallResult {
  config: DaemonConfig;
  paths: DaemonRuntimePaths;
  plistPath: string;
  label: string;
  plistXml: string;
  loaded: boolean;
}

/**
 * Process bootstrap and launchd lifecycle for the per-workspace daemon
 * (SPEC-PRD-0020-P1 T-01). No watch/poll modules — start, stop, install,
 * uninstall, and exit codes only.
 */
export interface IDaemonLifecycleService {
  /** Validate workspace root + config, write pid/log, then block until signal. */
  run(workspaceRoot: string): Promise<DaemonRuntimePaths>;
  install(
    workspaceRoot: string,
    options?: DaemonInstallOptions
  ): DaemonInstallResult;
  uninstall(
    workspaceRoot: string,
    options?: Pick<DaemonInstallOptions, 'plistDir'>
  ): { label: string };
}

@injectable()
export class DaemonLifecycleService implements IDaemonLifecycleService {
  constructor(
    @inject(WORKFLOW_TOKENS.DaemonConfigRepository)
    private readonly _configRepo: IDaemonConfigRepository,
    @inject(WORKFLOW_TOKENS.DaemonProcessRepository)
    private readonly _processRepo: IDaemonProcessRepository,
    @inject(WORKFLOW_TOKENS.LaunchdRepository)
    private readonly _launchdRepo: ILaunchdRepository
  ) {}

  async run(workspaceRoot: string): Promise<DaemonRuntimePaths> {
    const { paths } = this._configRepo.load(workspaceRoot);
    this._processRepo.writePid({
      pidFile: paths.pidFile,
      logPath: paths.logPath
    });
    try {
      await this._processRepo.waitForShutdown();
    } finally {
      this._processRepo.clearPid(paths.pidFile, process.pid);
    }
    return paths;
  }

  install(
    workspaceRoot: string,
    options: DaemonInstallOptions = {}
  ): DaemonInstallResult {
    const { config, paths } = this._configRepo.load(workspaceRoot);
    // launchd opens StandardOutPath/StandardErrorPath at load/start; create
    // the state directory and touch the log before bootstrap/enable.
    this._processRepo.ensureState({
      pidFile: paths.pidFile,
      logPath: paths.logPath
    });
    const program = options.program ?? process.execPath;
    const cliEntry =
      options.cliEntry ?? path.resolve(__dirname, '..', 'index.js');

    const result = this._launchdRepo.install({
      label: paths.launchdLabel,
      program,
      programArguments: [
        cliEntry,
        'daemon',
        '--workspace',
        config.workspaceRoot
      ],
      workingDirectory: config.workspaceRoot,
      stdoutPath: paths.logPath,
      stderrPath: paths.logPath,
      environment: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? ''
      },
      plistDir: options.plistDir,
      load: options.load
    });

    return {
      config,
      paths,
      plistPath: result.plistPath,
      label: result.label,
      plistXml: result.plistXml,
      loaded: result.loaded
    };
  }

  uninstall(
    workspaceRoot: string,
    options: Pick<DaemonInstallOptions, 'plistDir'> = {}
  ): { label: string } {
    // Label/plist path are derived from the workspace root alone so a
    // missing or malformed `.sdlc/daemon.json` cannot strand a launchd agent.
    const paths = this._configRepo.derivePaths(workspaceRoot);
    this._launchdRepo.uninstall(paths.launchdLabel, options.plistDir);
    return { label: paths.launchdLabel };
  }
}
