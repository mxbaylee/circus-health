import { HttpError } from './database.ts';
import type {
  IntakePersonEnvelopeProposal,
  IntakePersonField,
  IntakePersonRole,
} from '../shared/intake-people.ts';
import type { HealthRecordEnvelope } from '../shared/intake.ts';
import { personContactError } from '../shared/person-care.ts';

type UnknownRecord = Record<string, unknown>;

export const INTAKE_PEOPLE_INSTRUCTIONS = `Use optional top-level people:[{id:string,fullName:string,role:clinician|relative,title?:string,relationship?:string,phone?:string,email?:string,schedulingUrl?:string,medicalHistory?:string,evidence:[{textAnchor:string,supports:(fullName|title|relationship|phone|email|schedulingUrl|medicalHistory)[],locator?:string,memberId?:string,page?:number}],uncertainties?:string[]}] for first-class, separately reviewed People proposals. Propose only an explicitly named human clinician or relative. A role word alone (doctor, mother, uncle), an organization, or Self is not a Person proposal; keep it unchanged in payload. Every evidence textAnchor must occur verbatim in this envelope payload and contain the proposed fullName. Each contact/history field must be copied literally from a supporting anchor that contains both the name and that field; never borrow a clinic switchboard, another person's contact, or history elsewhere in the document. Preserve association uncertainty. A clinician mention supports only Professional, never a current PCP/care-team or emergency role. A named relative's literal medical/family history belongs only to that relative and never becomes Self clinical data. Do not infer life status. Repeat the exact report memberId for package evidence. Every envelope containing people requires top-level kind:"record" and an explicit report scope, even when clinical.kind is "document" for an optical prescription. Put optical fields in clinical.opticalPrescription. Do not attach people to top-level document or context envelopes. A people-only envelope uses kind:"record", retains its report/source scope, and omits clinical; it must not create an unsupported Self clinical proposal. People remain pending until the user explicitly chooses Add or an exact-version Update.`;

export const INTAKE_PEOPLE_EVIDENCE_INSTRUCTIONS = `For a named signer, retain the complete same-person signature passage in textAnchor so source-only credential, license and signature date/time details remain visible in the reviewed Person note and evidence. Those details are not first-class Person fields: do not invent fields, encode them as relationship/contact/medical history, or infer a prescriber/care-team relationship. List in supports only the existing Person fields actually copied from the passage.`;

const fields = [
  'fullName',
  'title',
  'relationship',
  'phone',
  'email',
  'schedulingUrl',
  'medicalHistory',
] as const satisfies readonly IntakePersonField[];
const proposalKeys = new Set([
  'id',
  'fullName',
  'role',
  'title',
  'relationship',
  'phone',
  'email',
  'schedulingUrl',
  'medicalHistory',
  'evidence',
  'uncertainties',
]);
const evidenceKeys = new Set(['textAnchor', 'supports', 'locator', 'memberId', 'page']);
const roleLabels = new Set([
  'aunt',
  'brother',
  'cardiologist',
  'clinician',
  'counselor',
  'cousin',
  'daughter',
  'dentist',
  'doctor',
  'dr',
  'father',
  'friend',
  'granddaughter',
  'grandfather',
  'grandmother',
  'grandparent',
  'grandson',
  'husband',
  'md',
  'mother',
  'nephew',
  'neurologist',
  'niece',
  'np',
  'nurse',
  'oncologist',
  'ophthalmologist',
  'optometrist',
  'pa',
  'parent',
  'partner',
  'pharmacist',
  'physician',
  'psychiatrist',
  'psychologist',
  'relative',
  'sibling',
  'sister',
  'son',
  'specialist',
  'spouse',
  'surgeon',
  'therapist',
  'uncle',
  'wife',
]);
const roleQualifiers = new Set([
  'a',
  'adoptive',
  'an',
  'attending',
  'biological',
  'care',
  'family',
  'her',
  'his',
  'maternal',
  'my',
  'our',
  'patient',
  'paternal',
  'primary',
  'step',
  'the',
  'their',
  'your',
]);
const organizationOnly =
  /\b(?:clinic|hospital|medical center|health center|health system|practice|group)\b/iu;
const clinicianSignal =
  /\b(?:dr\.?|doctor|physician|clinician|nurse|np|pa|therapist|counselor|dentist|surgeon|pharmacist|specialist|cardiologist|neurologist|oncologist|psychiatrist|psychologist|optometrist|ophthalmologist|md|d\.o\.)\b/iu;
const clinicianCredentialSuffix =
  /^\s*,?\s*(?:m\.?d\.?|d\.?o\.?|o\.?d\.?|d\.?d\.?s\.?|d\.?m\.?d\.?)\b/iu;
const kinshipSignal =
  /\b(?:aunt|brother|cousin|daughter|father|granddaughter|grandfather|grandmother|grandparent|grandson|mother|nephew|niece|parent|relative|sibling|sister|son|spouse|uncle|wife|husband|partner)\b/iu;

const object = (value: unknown): value is UnknownRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !JSON.isRawJSON(value);
const normalized = (value: string): string => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const roleOnly = (value: string): boolean => {
  const tokens = normalized(value)
    .toLocaleLowerCase('en-US')
    .replace(/[’']s\b/gu, '')
    .match(/\p{L}+/gu);
  return Boolean(
    tokens?.some((token) => roleLabels.has(token)) &&
    tokens.every((token) => roleLabels.has(token) || roleQualifiers.has(token)),
  );
};
const nameCharacter = /[\p{L}\p{N}]/u;
const includesLiteralName = (container: string, value: string): boolean => {
  for (
    let index = container.indexOf(value);
    index >= 0;
    index = container.indexOf(value, index + 1)
  ) {
    const before = index > 0 ? container[index - 1]! : '';
    const after = container[index + value.length] || '';
    if (!nameCharacter.test(before) && !nameCharacter.test(after)) return true;
  }
  return false;
};

/** Source titles may be credentials, not names. Never initialize a Person with a role-only label. */
export function intakePersonDisplayTitle(
  proposal: Pick<IntakePersonEnvelopeProposal, 'fullName' | 'title'>,
): string {
  return proposal.title &&
    includesLiteralName(
      normalized(proposal.title).toLocaleLowerCase('en-US'),
      normalized(proposal.fullName).toLocaleLowerCase('en-US'),
    )
    ? proposal.title
    : proposal.fullName;
}

const boundedText = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string' || !normalized(value) || value.length > max)
    throw new HttpError(400, 'INTAKE_PERSON', `${label} must be nonempty bounded text`);
  return value;
};

function payloadContains(payload: unknown, anchor: string, depth = 0): boolean {
  if (depth > 20) return false;
  if (typeof payload === 'string') return payload.includes(anchor);
  if (JSON.isRawJSON(payload)) return JSON.stringify(payload).includes(anchor);
  if (Array.isArray(payload))
    return payload.some((item) => payloadContains(item, anchor, depth + 1));
  if (object(payload))
    return Object.values(payload).some((item) => payloadContains(item, anchor, depth + 1));
  return false;
}

function roleSupported(
  role: IntakePersonRole,
  proposal: UnknownRecord,
  anchors: string[],
): boolean {
  const passage = anchors.join('\n');
  if (role === 'clinician') {
    if (clinicianSignal.test(passage)) return true;
    // Credentials must follow this person's name. An optical OD/OS table
    // elsewhere in a patient's evidence passage does not identify a clinician.
    const fullName = proposal.fullName as string;
    return anchors.some((anchor) => {
      for (
        let index = anchor.indexOf(fullName);
        index >= 0;
        index = anchor.indexOf(fullName, index + 1)
      ) {
        if (clinicianCredentialSuffix.test(anchor.slice(index + fullName.length))) return true;
      }
      return false;
    });
  }
  return (
    typeof proposal.relationship === 'string' &&
    kinshipSignal.test(proposal.relationship) &&
    anchors.some(
      (anchor) => anchor.includes(proposal.relationship as string) && kinshipSignal.test(anchor),
    )
  );
}

/**
 * Validate only explicitly named, same-passage Person proposals. Malformed or
 * weakly associated proposals fail the retained conversion instead of becoming
 * generic People or borrowing contact/history from elsewhere in the payload.
 */
export function validatedIntakePeople(
  envelope: HealthRecordEnvelope,
): IntakePersonEnvelopeProposal[] {
  if (!Object.hasOwn(envelope, 'people')) return [];
  if (!Array.isArray(envelope.people) || envelope.people.length > 50)
    throw new HttpError(
      400,
      'INTAKE_PERSON',
      'People must be a list of at most 50 named proposals',
    );
  if (envelope.people.length && envelope.kind !== 'record')
    throw new HttpError(
      400,
      'INTAKE_PERSON',
      'Named People proposals require a report-scoped record envelope',
    );
  const result: IntakePersonEnvelopeProposal[] = [];
  const seen = new Set<string>();
  for (const raw of envelope.people) {
    if (!object(raw) || Object.keys(raw).some((key) => !proposalKeys.has(key)))
      throw new HttpError(
        400,
        'INTAKE_PERSON',
        'A named Person proposal contains unsupported fields',
      );
    const id = boundedText(raw.id, 'Person proposal id', 500);
    if (seen.has(id))
      throw new HttpError(400, 'INTAKE_PERSON', 'Person proposal ids must be unique per envelope');
    seen.add(id);
    const fullName = boundedText(raw.fullName, 'Person full name', 500);
    if (!/\p{L}/u.test(fullName) || roleOnly(fullName))
      throw new HttpError(
        400,
        'INTAKE_PERSON_NAME',
        'A relationship or profession without a personal name stays retained source text',
      );
    const role = raw.role;
    if (role !== 'clinician' && role !== 'relative')
      throw new HttpError(
        400,
        'INTAKE_PERSON_ROLE',
        'People proposals support named clinicians or relatives',
      );
    if (organizationOnly.test(fullName))
      throw new HttpError(
        400,
        'INTAKE_PERSON_NAME',
        'An organization label cannot become a Person proposal',
      );
    if (!Array.isArray(raw.evidence) || !raw.evidence.length || raw.evidence.length > 20)
      throw new HttpError(
        400,
        'INTAKE_PERSON_EVIDENCE',
        'Each Person needs bounded named evidence',
      );
    const evidence = raw.evidence.map((item) => {
      if (!object(item) || Object.keys(item).some((key) => !evidenceKeys.has(key)))
        throw new HttpError(
          400,
          'INTAKE_PERSON_EVIDENCE',
          'Person evidence contains unsupported fields',
        );
      const textAnchor = boundedText(item.textAnchor, 'Person evidence anchor', 4000);
      if (!payloadContains(envelope.payload, textAnchor))
        throw new HttpError(
          400,
          'INTAKE_PERSON_EVIDENCE',
          'Person evidence must occur verbatim in the same envelope payload',
        );
      if (!includesLiteralName(textAnchor, fullName))
        throw new HttpError(
          400,
          'INTAKE_PERSON_NAME',
          'The named person must occur in every supporting evidence passage',
        );
      if (
        !Array.isArray(item.supports) ||
        !item.supports.length ||
        item.supports.some((field) => !fields.includes(field as IntakePersonField)) ||
        new Set(item.supports).size !== item.supports.length
      )
        throw new HttpError(
          400,
          'INTAKE_PERSON_EVIDENCE',
          'Person evidence must name each field it supports',
        );
      if (
        Object.hasOwn(item, 'memberId') &&
        (typeof item.memberId !== 'string' ||
          !item.memberId.trim() ||
          item.memberId.length > 500 ||
          item.memberId !== envelope.report?.memberId)
      )
        throw new HttpError(
          400,
          'INTAKE_PERSON_SCOPE',
          'Person evidence member must match the envelope report member',
        );
      if (envelope.report?.memberId && item.memberId !== envelope.report.memberId)
        throw new HttpError(
          400,
          'INTAKE_PERSON_SCOPE',
          'Package Person evidence must repeat the report member id',
        );
      const page = JSON.isRawJSON(item.page) ? Number(JSON.stringify(item.page)) : item.page;
      if (Object.hasOwn(item, 'page') && (!Number.isSafeInteger(page) || (page as number) < 1))
        throw new HttpError(400, 'INTAKE_PERSON_EVIDENCE', 'Person evidence page must be positive');
      return {
        textAnchor,
        supports: item.supports as IntakePersonField[],
        ...(item.locator === undefined
          ? {}
          : { locator: boundedText(item.locator, 'Person evidence locator', 2000) }),
        ...(typeof item.memberId === 'string' ? { memberId: item.memberId } : {}),
        ...(typeof page === 'number' ? { page } : {}),
      };
    });
    const proposal = { ...raw, id, fullName, role } as UnknownRecord & {
      role: IntakePersonRole;
    };
    for (const field of fields) {
      if (field === 'fullName') {
        if (!evidence.some((item) => item.supports.includes(field)))
          throw new HttpError(400, 'INTAKE_PERSON_EVIDENCE', 'Person name needs explicit evidence');
        continue;
      }
      if (!Object.hasOwn(raw, field)) continue;
      const value = boundedText(
        raw[field],
        `Person ${field}`,
        field === 'medicalHistory' ? 100000 : field === 'title' ? 500 : 2048,
      );
      if (
        !evidence.some((item) => item.supports.includes(field) && item.textAnchor.includes(value))
      )
        throw new HttpError(
          400,
          'INTAKE_PERSON_ASSOCIATION',
          `Person ${field} must occur with the name in its supporting passage`,
        );
      proposal[field] = value;
    }
    if (
      !roleSupported(
        role,
        proposal,
        evidence.map((item) => item.textAnchor),
      )
    )
      throw new HttpError(
        400,
        'INTAKE_PERSON_ROLE',
        'The named passage must explicitly support the clinician or relative role',
      );
    if (
      raw.uncertainties !== undefined &&
      (!Array.isArray(raw.uncertainties) ||
        raw.uncertainties.length > 50 ||
        raw.uncertainties.some(
          (value) => typeof value !== 'string' || !normalized(value) || value.length > 4000,
        ))
    )
      throw new HttpError(400, 'INTAKE_PERSON', 'Person uncertainties must be bounded text');
    const contactError = personContactError(proposal);
    if (contactError) throw new HttpError(400, 'INTAKE_PERSON_CONTACT', contactError);
    result.push({
      id,
      fullName,
      role,
      ...Object.fromEntries(
        fields
          .filter((field) => field !== 'fullName' && typeof proposal[field] === 'string')
          .map((field) => [field, proposal[field]]),
      ),
      evidence,
      ...(Array.isArray(raw.uncertainties)
        ? { uncertainties: [...new Set(raw.uncertainties.map((value) => normalized(value)))] }
        : {}),
    });
  }
  return result;
}
