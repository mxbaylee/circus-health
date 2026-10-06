import type { PrfDiagnostics } from './diagnostics.ts';

/** Public, browser-local fictional checker data. Never add PRF output or keys. */
export interface BuildInfo {
  version: string;
  revision: string;
  worktree: string;
}
export type MetadataSource = 'browser-reported' | 'operator' | 'unknown';
export interface MetadataField {
  value: string;
  source: MetadataSource;
  reportedValue?: string;
}
export const ENVIRONMENT_FIELDS = [
  'browser',
  'browserVersion',
  'os',
  'osVersion',
  'provider',
  'providerVersion',
] as const;
export type EnvironmentField = (typeof ENVIRONMENT_FIELDS)[number];
export type Environment = Record<EnvironmentField, MetadataField>;
export const CREDENTIAL_ALIASES = ['A', 'B', 'C'] as const;
export type CredentialAlias = (typeof CREDENTIAL_ALIASES)[number];
export const KNOWN_TRANSPORTS = ['ble', 'hybrid', 'internal', 'nfc', 'usb'] as const;
export type Step =
  | 'create'
  | 'confirm'
  | 'use-1'
  | 'use-2'
  | 'use-3'
  | 'use-after-b'
  | 'use-after-b-failed'
  | 'recheck'
  | 'recover';
export const STEP_LABELS: Record<Step, string> = {
  create: 'Create credential',
  confirm: 'Confirm PRF and fictional encryption',
  'use-1': 'Fresh use 1',
  'use-2': 'Fresh use 2',
  'use-3': 'Fresh use 3',
  'use-after-b': 'Use A after B is created',
  'use-after-b-failed': 'Use A after B creation fails',
  recheck: 'Final fresh verification',
  recover: 'Check retained access after an additional creation failed',
};
export function stepsForAlias(alias: CredentialAlias, flow?: RunHeader['flow']): Step[] {
  if (flow === 'abc-username-v1') return ['create', 'confirm', 'recover', 'recheck'];
  const steps: Step[] = ['create', 'confirm', 'use-1', 'use-2', 'use-3'];
  return alias === 'A' ? [...steps, 'use-after-b', 'use-after-b-failed'] : steps;
}
export const ERROR_MESSAGES = {
  'insecure-context': 'A valid HTTPS secure context is required.',
  unsupported: 'The native credential API or required operation is unavailable.',
  'not-allowed':
    'The request was cancelled, timed out, or refused; the browser does not distinguish these causes.',
  'invalid-state':
    'The authenticator refused the credential state, possibly because it already exists.',
  'security-error': 'The browser refused the origin or relying-party scope.',
  aborted: 'The request was interrupted.',
  'wrong-credential': 'The returned credential did not match the requested credential.',
  'duplicate-credential': 'A distinct second credential was not returned.',
  'invalid-credential': 'The browser did not return a usable public credential.',
  'missing-prf': 'No valid 32-byte PRF result was returned.',
  'prf-absent': 'The browser returned no PRF result for this request.',
  'prf-invalid': 'The returned PRF result was not a supported 32-byte representation.',
  'decrypt-failed': 'The fresh PRF result could not decrypt and match the fictional value.',
  unconfirmed: 'Confirm this credential before testing further uses.',
  'scope-mismatch': 'This saved run belongs to a different origin or relying-party scope.',
  'unknown-error': 'The request failed without a safely classifiable reason.',
} as const;
export type ErrorCode = keyof typeof ERROR_MESSAGES;
export interface RunHeader {
  schemaVersion: 1;
  /** Absent on historical A/B rounds; never infer a new protocol for an old run. */
  flow?: 'abc-username-v1';
  registrationMode?: 'eval' | 'enable-only';
  id: string;
  origin: string;
  secureContext: boolean;
  rpId: string;
  userId: string;
  createdAt: string;
  build: BuildInfo;
  environment: Environment;
}
export interface CredentialRecord {
  alias: CredentialAlias;
  /** Public credential reference; local only and never exported. */
  id: string;
  salt: string;
  transports?: AuthenticatorTransport[];
  cipher?: { iv: string; data: string };
}
export interface Attempt {
  id: string;
  alias: CredentialAlias;
  step: Step;
  status: 'pending' | 'created' | 'verified' | 'failed' | 'interrupted' | 'skipped';
  error?: ErrorCode;
  diagnostics?: PrfDiagnostics;
  /** Local reference for a retained-access check after this exact failed/interrupted creation. */
  afterAttemptId?: string;
  /** Causal order for new attempts; legacy rows retain their original timestamps. */
  sequence?: number;
  startedAt: string;
  finishedAt?: string;
  build: BuildInfo;
  environment: Environment;
}
export interface Observation {
  id: string;
  alias: CredentialAlias;
  step: Step | 'general';
  outcome: 'worked' | 'failed' | 'could-not-test';
  note: string;
  createdAt: string;
  build: BuildInfo;
  environment: Environment;
}
export interface CheckerState {
  run: RunHeader;
  credentials: CredentialRecord[];
  attempts: Attempt[];
  observations: Observation[];
}
