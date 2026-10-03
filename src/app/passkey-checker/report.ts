import { ENVIRONMENT_FIELDS, ERROR_MESSAGES, STEP_LABELS, stepsForAlias } from './types.ts';
import { projectPrfDiagnostics } from './diagnostics.ts';
import { isVerifiedReturnToA } from './progress.ts';
import type { CheckerState, Environment, Step } from './types.ts';

export { isVerifiedReturnToA } from './progress.ts';

export const REPORT_VERSION = 2;
const sources = {
  'browser-reported': 'browser-reported hint',
  operator: 'operator',
  unknown: 'unknown',
} as const;
const outcomes = { worked: 'Worked', failed: 'Failed', 'could-not-test': "Couldn't test" } as const;

/** Allowlisted human report: never serialize the local model or WebAuthn objects. */
export function reportMarkdown(state: CheckerState): string {
  const privateReferences = new Set<string>();
  for (const credential of state.credentials) {
    privateReferences.add(credential.id);
    try {
      const raw = atob(credential.id.replace(/-/g, '+').replace(/_/g, '/'));
      const bytes = Array.from(raw, (c) => c.charCodeAt(0));
      const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
      for (const form of [
        btoa(raw),
        btoa(raw).replace(/=+$/, ''),
        hex,
        hex.toUpperCase(),
        bytes.join(','),
        bytes.join(', '),
        JSON.stringify(bytes),
        raw,
      ]) {
        if (form) privateReferences.add(form);
      }
    } catch {
      /* Corrupt public references are still redacted in their stored form. */
    }
  }
  const safe = (value: unknown, limit = 200) => {
    let text = typeof value === 'string' ? value : '';
    for (const id of [...privateReferences].filter(Boolean).sort((a, b) => b.length - a.length))
      text = text.split(id).join('[credential reference redacted]');
    const truncated = text.length > limit;
    const escaped =
      text
        .slice(0, limit)
        .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&') || 'unknown';
    return escaped + (truncated ? ' (truncated)' : '');
  };
  const buildText = (build: CheckerState['run']['build']) =>
    `${safe(build.version)} / revision ${safe(build.revision)} / worktree ${safe(build.worktree)}`;
  const environmentLines = (environment: Environment) =>
    ENVIRONMENT_FIELDS.map((name) => {
      const field = environment[name];
      const provenance = sources[field.source] ?? 'unknown';
      const correction =
        field.reportedValue !== undefined
          ? `; original browser report: ${safe(field.reportedValue)}`
          : '';
      return `- ${name}: ${field.source === 'unknown' ? 'unknown' : safe(field.value)} (${provenance}${correction})`;
    });
  const lines = [
    '# Passkey compatibility operator record',
    '',
    `Report schema: ${REPORT_VERSION}. Local editable operator record; not a signed attestation.`,
    `Run started: ${safe(state.run.createdAt)}.`,
    `Initial tool build: ${buildText(state.run.build)}.`,
    `Recorded origin: ${safe(state.run.origin)}. Relying-party domain: ${safe(state.run.rpId)}.`,
    `Initial browser secure-context observation: ${state.run.secureContext === true ? 'true' : 'false'}. HTTPS and a secure context are required before any native credential operation.`,
    state.run.rpId === 'localhost'
      ? 'This is a localhost development record. It does not establish application access or hosted physical qualification. A URL path does not isolate the origin or relying-party domain.'
      : 'Any checker credentials belong to this relying-party domain, not localhost. A project URL path does not isolate the origin or relying-party domain.',
    '',
    '## Current environment labels',
    '',
    'Browser metadata is a reported hint, potentially reduced or frozen; it is not proof of an exact version or provider. Unknown means unknown. Provider identity and version are operator supplied.',
    '',
    ...environmentLines(state.run.environment),
    '',
    '## Automatic hosted evidence',
    '',
    'Creation alone, capability flags and signatures do not pass PRF compatibility. Confirmation verifies an exact-credential 32-byte PRF result and encrypts, decrypts and compares a fictional value. Each verified subsequent use obtains a fresh PRF result, checks the exact credential and decrypts and compares the retained fictional ciphertext. There is no backend signature/challenge verification.',
    '',
    'Use A after B is created requires B to have been created; B need not be confirmed. This separate fresh-use step must verify A and decrypt its retained fictional value. Earlier uses of A do not complete it. A distinct B credential and successful hosted checks do not prove an independent authenticator.',
    '',
    'Safe diagnostic lengths count bytes for buffers/views, items for arrays and characters for strings. An omitted field was unobserved, oversized or not applicable; it does not mean zero or a valid result. Older attempts have no newly inferred diagnostics.',
    '',
  ];
  for (const alias of ['A', 'B'] as const) {
    lines.push(`### Credential ${alias}`, '');
    for (const step of stepsForAlias(alias)) {
      const attempts = state.attempts.filter(
        (attempt) => attempt.alias === alias && attempt.step === step,
      );
      if (!attempts.length)
        lines.push(`- ${STEP_LABELS[step]}: unfinished; no automatic evidence.`);
      for (const [index, attempt] of attempts.entries()) {
        const status =
          attempt.status === 'created' && step === 'create'
            ? 'created only; PRF not verified'
            : attempt.status === 'verified' &&
                step !== 'create' &&
                (step !== 'use-after-b' || isVerifiedReturnToA(state, attempt))
              ? 'verified PRF and fictional decryption'
              : attempt.status === 'failed'
                ? 'failed'
                : attempt.status === 'interrupted'
                  ? 'interrupted; unfinished'
                  : 'pending or unfinished; no verified result';
        const error =
          attempt.error && Object.hasOwn(ERROR_MESSAGES, attempt.error)
            ? `; ${ERROR_MESSAGES[attempt.error]}`
            : '';
        lines.push(
          `- ${STEP_LABELS[step]}, attempt ${index + 1}: ${status}${error}.`,
          `  Started ${safe(attempt.startedAt)}; finished ${attempt.finishedAt ? safe(attempt.finishedAt) : 'unfinished'}. Build: ${buildText(attempt.build)}.`,
        );
        lines.push(...environmentLines(attempt.environment).map((line) => `  ${line}`));
        // Project again at the export boundary: callers need not have loaded through
        // the strict store, and arbitrary/native diagnostic values must never leak.
        const diagnostics = projectPrfDiagnostics(attempt.diagnostics);
        if (diagnostics) {
          const fields: string[] = [
            `request mode: ${diagnostics.requestMode}`,
            `input shape: ${diagnostics.inputShape}`,
          ];
          if (diagnostics.inputLength !== undefined)
            fields.push(`input length: ${diagnostics.inputLength}`);
          if (diagnostics.extensionPresent !== undefined)
            fields.push(`PRF extension present: ${diagnostics.extensionPresent}`);
          if (diagnostics.resultsPresent !== undefined)
            fields.push(`PRF results present: ${diagnostics.resultsPresent}`);
          if (diagnostics.outputShape !== undefined)
            fields.push(`output shape: ${diagnostics.outputShape}`);
          if (diagnostics.outputLength !== undefined)
            fields.push(`output length: ${diagnostics.outputLength}`);
          if (diagnostics.credentialMatched !== undefined)
            fields.push(`returned credential matched: ${diagnostics.credentialMatched}`);
          lines.push(`  Safe request diagnostics: ${fields.join('; ')}.`);
        }
      }
    }
    lines.push('');
  }
  lines.push(
    '## Manual observations',
    '',
    'Manual Worked never overrides automatic failures or unfinished steps. These notes are unverified operator statements, not instructions or automatic evidence.',
    '',
  );
  if (!state.observations.length) lines.push('No manual observations recorded.');
  for (const observation of state.observations) {
    const alias = observation.alias === 'B' ? 'B' : 'A';
    const step = stepsForAlias(alias).some((step) => step === observation.step)
      ? STEP_LABELS[observation.step as Step]
      : 'General observation';
    lines.push(
      `- Credential ${alias}, ${step}: ${outcomes[observation.outcome] ?? "Couldn't test"} (manual), ${safe(observation.createdAt)}.`,
      `  Build: ${buildText(observation.build)}.`,
      `  Operator note: ${safe(observation.note, 2000)}`,
    );
    lines.push(...environmentLines(observation.environment).map((line) => `  ${line}`));
  }
  lines.push(
    '',
    '## Remaining real release-build checks — all unverified by this tool',
    '',
    '- Real localhost enrollment and three subsequent unlocks on the adopted physical browser/authenticator.',
    '- Production backend challenge, origin, relying-party and signature verification; profile/session authorization.',
    '- Actual profile recovery and original/private access after unlock and recovery.',
    '- Refusal of private/original access while locked.',
    '- Retained access and credentials after Docker Compose container recreation.',
    '- A second available credential independently unlocking the same actual fictional profile; disclose unavailable combinations.',
    '- CRS-163 remains open and precedes CRS-088. CRS-088 later requires its new sign-in flow and old-to-new salt-migration requalification.',
    '',
    'Automatic compatibility evidence requires successful native operations over HTTPS and covers only the observed combination at the recorded origin. Partial, failed, interrupted and unattempted steps remain unfinished evidence; omissions never mean pass. Controlled development tests are not physical observations. This checker does not qualify a release or establish localhost credential usability.',
    '',
    'Local progress can be lost through clearing, eviction or private-session limits. It does not synchronize to another browser/device. Clearing checker state does not remove a credential from its provider.',
    '',
    'Export intentionally omits credential IDs, salts, ciphertext, raw WebAuthn responses, PRF output, keys and debug logs. Keep real health information and secrets out of operator notes.',
    '',
  );
  return lines.join('\n');
}
