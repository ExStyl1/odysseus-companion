import type {
  NessyPluginManifest,
  PluginCompatibilityReport,
  PluginDiagnostic,
  PluginEcosystemFormat,
  PluginFormatAdapter,
  PluginInstallPlan,
  PluginInstallSource,
  PluginScope,
  PluginStagedInstall,
} from './types.ts';

export type PluginAgentInstallProposalSource = Exclude<PluginInstallSource, { kind: 'agent-proposed' }>;

export interface ResolvePluginInstallSourceOptions {
  cwd?: string;
  now?: () => number;
  defaultMarketplaceId?: string;
  defaultMarketplaceBaseUrl?: string;
}

export interface PluginInstallPlanOptions extends ResolvePluginInstallSourceOptions {
  requestedScope?: PluginScope;
  diagnostics?: PluginDiagnostic[];
}

export type CreatePluginInstallPlanOptions = PluginInstallPlanOptions;

/** Public options for staging and normalizing a bundle before v2 commit. */
export interface PluginInstallServiceOptions {
  fetchImpl?: typeof fetch;
  artifactAuthProvider?: PluginArtifactAuthProvider;
  runtimeDependencyInstaller?: PluginRuntimeDependencyInstaller;
  baseTempDir?: string;
  formatAdapters?: PluginFormatAdapter[];
  now?: () => number;
}

export type PluginRuntimeDependencyInstallRequest =
  | {
      mode: 'locked';
      directory: string;
      packageJsonPath: string;
      lockfilePath: string;
      production: true;
      ignoreScripts: true;
      frozenLockfile: true;
    }
  | {
      mode: 'generate-lock';
      directory: string;
      packageJsonPath: string;
      production: true;
      ignoreScripts: true;
      frozenLockfile: false;
    };

/** Host-owned, argv-based package installation seam for a verified staging directory. */
export type PluginRuntimeDependencyInstaller = (
  request: PluginRuntimeDependencyInstallRequest
) => Promise<void>;

export interface PluginStagedNormalizationResult {
  manifest?: NessyPluginManifest;
  adapterId?: string;
  adapterVersion?: string;
  /** Ecosystem format detected for this bundle (A3); presentation/reporting only. */
  detectedFormat?: PluginEcosystemFormat;
  /** Lossless compatibility summary for the detected format (A2/A3). */
  compatibility?: PluginCompatibilityReport;
  diagnostics: PluginDiagnostic[];
}

export interface PluginAgentInstallProposal {
  label: string;
  source: PluginAgentInstallProposalSource;
  rationale?: string;
  requestedScope?: PluginScope;
}

export interface PluginAgentInstallProposalResult {
  source: PluginInstallSource;
  plan: PluginInstallPlan;
  diagnostics: PluginDiagnostic[];
  confirmationSummary: string[];
}

export interface PluginArtifactAuthProvider {
  fetchArtifact(url: URL, fetchImpl: typeof fetch): Promise<Response>;
}
