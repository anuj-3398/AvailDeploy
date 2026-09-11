/** Shared domain types for the Avail Deploy platform. */

export type DeploymentState =
  | 'QUEUED'
  | 'INITIALIZING'
  | 'BUILDING'
  | 'UPLOADING'
  | 'READY'
  | 'ERROR'
  | 'CANCELED'
  | 'SKIPPED';

export const TERMINAL_STATES: DeploymentState[] = ['READY', 'ERROR', 'CANCELED', 'SKIPPED'];

export type DeploymentTarget = 'production' | 'preview';

export type EnvTarget = 'production' | 'preview' | 'development';

export type DeploymentSource =
  | 'git'
  | 'cli'
  | 'manual'
  | 'redeploy'
  | 'rollback';

/** How the finished build is served by the proxy. */
export type ServeMode = 'static' | 'server';

export type UserRole = 'owner' | 'member';

export interface User {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  role: UserRole;
  created_at: number;
  last_login_at: number | null;
}

export interface Session {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  user_agent: string | null;
}

export interface GitIntegration {
  id: string;
  user_id: string;
  provider: 'github';
  kind: 'oauth' | 'pat';
  login: string;
  avatar_url: string | null;
  /** AES-256-GCM encrypted access token. */
  token_enc: string;
  scopes: string | null;
  created_at: number;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  framework: string | null;
  root_directory: string | null;
  install_command: string | null;
  build_command: string | null;
  output_directory: string | null;
  dev_command: string | null;
  node_version: string;
  /** Serve the build output statically, or run a long-lived server process. */
  serve_mode: ServeMode | null;
  repo_provider: string | null;
  repo_full_name: string | null;
  repo_id: string | null;
  repo_default_branch: string | null;
  production_branch: string;
  /** 1 = deploy automatically on push. */
  auto_deploy: number;
  /** 1 = build previews for pull requests. */
  preview_deploys: number;
  git_integration_id: string | null;
  webhook_secret: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface EnvVar {
  id: string;
  project_id: string;
  key: string;
  value_enc: string;
  target: EnvTarget;
  git_branch: string | null;
  created_at: number;
  updated_at: number;
  created_by: string | null;
}

export interface Deployment {
  id: string;
  project_id: string;
  state: DeploymentState;
  target: DeploymentTarget;
  source: DeploymentSource;
  branch: string | null;
  commit_sha: string | null;
  commit_message: string | null;
  commit_author: string | null;
  commit_url: string | null;
  pr_number: number | null;
  /** Immutable per-deployment hostname. */
  url: string;
  /** Detected/resolved framework slug. */
  framework: string | null;
  serve_mode: ServeMode | null;
  /** Command used to boot a `server` deployment. */
  start_command: string | null;
  output_path: string | null;
  error: string | null;
  created_by: string | null;
  created_at: number;
  building_at: number | null;
  ready_at: number | null;
  build_duration_ms: number | null;
  /** 1 = currently serving the production alias. */
  is_current_production: number;
  meta: string | null;
}

export interface BuildLog {
  id: number;
  deployment_id: string;
  seq: number;
  ts: number;
  level: 'info' | 'warn' | 'error' | 'command' | 'stdout' | 'stderr';
  text: string;
}

export interface Alias {
  id: string;
  domain: string;
  project_id: string;
  deployment_id: string | null;
  type: 'production' | 'branch' | 'deployment' | 'custom';
  created_at: number;
  updated_at: number;
}

/** Resolved build settings after merging preset -> avail.json -> project overrides. */
export interface ResolvedBuildSettings {
  framework: string | null;
  rootDirectory: string;
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  devCommand: string | null;
  serveMode: ServeMode;
  startCommand: string | null;
  nodeVersion: string;
}

/** `avail.json` / `vercel.json` project configuration file. */
export interface ProjectConfigFile {
  framework?: string | null;
  buildCommand?: string | null;
  installCommand?: string | null;
  outputDirectory?: string | null;
  devCommand?: string | null;
  rootDirectory?: string | null;
  serveMode?: ServeMode;
  startCommand?: string | null;
  cleanUrls?: boolean;
  trailingSlash?: boolean;
  redirects?: RedirectRule[];
  rewrites?: RewriteRule[];
  headers?: HeaderRule[];
  functions?: Record<string, { memory?: number; maxDuration?: number }>;
}

export interface RedirectRule {
  source: string;
  destination: string;
  permanent?: boolean;
  statusCode?: number;
}

export interface RewriteRule {
  source: string;
  destination: string;
}

export interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/** Written to the deployment output directory; read by the proxy. */
export interface DeploymentManifest {
  deploymentId: string;
  projectId: string;
  projectSlug: string;
  target: DeploymentTarget;
  framework: string | null;
  serveMode: ServeMode;
  startCommand: string | null;
  /** Directory (relative to the deployment dir) with static assets. */
  staticDir: string | null;
  /** Directory (relative to the deployment dir) with serverless functions. */
  functionsDir: string | null;
  /** Working directory for `server` deployments. */
  serverDir: string | null;
  functions: FunctionEntry[];
  config: ProjectConfigFile;
  env: Record<string, string>;
  nodeVersion: string;
  createdAt: number;
}

export interface FunctionEntry {
  /** Route path, e.g. `/api/hello`. */
  route: string;
  /** Entrypoint file relative to the functions dir. */
  file: string;
  runtime: 'nodejs';
  maxDuration: number;
}
