export interface RepoConfig {
  name: string;
  ghRepo: string;
  label?: string;
}

export interface SymlinkConfig {
  name: string;
  target: string;
  scope: 'project' | 'repo';
}

export interface ProjectConfig {
  id: string;
  dir: string;
  repos: RepoConfig[];
  symlinks: (string | SymlinkConfig)[];
  awsProfile?: string;
}

export interface TrackConfig {
  track: string;
  description: string;
  projects: ProjectConfig[];
}

export interface PersonalChronicleConfig {
  namePrefix: string;
  visibility: 'private' | 'internal' | 'public';
  label?: string;
  description: string;
  defaultBranch: string;
}

export interface SharedConfig {
  org: string;
  baseDir: string;
  sharedRepos: RepoConfig[];
  flatRepos: RepoConfig[];
  personalChronicle?: PersonalChronicleConfig;
  /** Resolved at runtime — the cloned repo name for this user's personal Chronicle. */
  resolvedPersonalChronicleRepo?: string;
}

export interface LocalFolderEntry {
  /** Relative to baseDir, or absolute. */
  path: string;
  /** Optional display name in VS Code. */
  name?: string;
}

export interface LocalConfig {
  localFolders: LocalFolderEntry[];
}

export interface SetupOptions {
  track: string;
  projects?: string[];
  baseDir?: string;
  skipInstall?: boolean;
  skipClone?: boolean;
}
