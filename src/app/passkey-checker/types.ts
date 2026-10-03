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
export type CredentialAlias = 'A' | 'B';
export const KNOWN_TRANSPORTS = ['ble', 'hybrid', 'internal', 'nfc', 'usb'] as const;
export type Step = 'create' | 'confirm' | 'use-1' | 'use-2' | 'use-3';
export const STEP_LABELS: Record<Step, string> = {
  create: 'Create credential',
  confirm: 'Confirm PRF and fictional encryption',
  'use-1': 'Fresh use 1',
  'use-2': 'Fresh use 2',
  'use-3': 'Fresh use 3',
};
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
  'decrypt-failed': 'The fresh PRF result could not decrypt and match the fictional value.',
  unconfirmed: 'Confirm this credential before testing further uses.',
  'scope-mismatch': 'This saved run belongs to a different origin or relying-party scope.',
  'unknown-error': 'The request failed without a safely classifiable reason.',
} as const;
export type ErrorCode = keyof typeof ERROR_MESSAGES;
export interface RunHeader {
  schemaVersion: 1;
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
  status: 'pending' | 'created' | 'verified' | 'failed' | 'interrupted';
  error?: ErrorCode;
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
