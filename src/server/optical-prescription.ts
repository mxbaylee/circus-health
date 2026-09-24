import type { IntakeClinicalMapping } from '../shared/intake.ts';
import type { OpticalEye, OpticalPrescription, OpticalValue } from '../shared/vision.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 10000;
const nonemptyText = (value: unknown): value is string => text(value) && !!value.trim();
const valueFields = [
  'sph',
  'cyl',
  'axis',
  'add',
  'prism',
  'pd',
  'baseCurve',
  'diameter',
] as const satisfies readonly (keyof OpticalEye)[];
const literalValue = (value: unknown): value is OpticalValue =>
  object(value) &&
  text(value.valueText) &&
  Object.keys(value).every((key) => ['valueText', 'unit'].includes(key)) &&
  (value.unit === undefined || text(value.unit));

export function opticalPrescriptionProblem(value: unknown): string | null {
  if (
    !object(value) ||
    typeof value.type !== 'string' ||
    !['spectacle', 'contact_lens', 'unknown'].includes(value.type) ||
    !Array.isArray(value.eyes) ||
    value.eyes.length > 20 ||
    Object.keys(value).some(
      (key) =>
        ![
          'type',
          'typeText',
          'statusText',
          'eyes',
          'prescribedDateText',
          'expiresDateText',
          'pd',
          'notes',
        ].includes(key),
    )
  )
    return 'Optical prescription requires a supported type and literal eye entries';
  for (const key of ['typeText', 'statusText'])
    if (value[key] !== undefined && !nonemptyText(value[key]))
      return 'Optical source type and status must be nonempty literal text when supplied';
  for (const key of ['prescribedDateText', 'expiresDateText', 'notes'])
    if (value[key] !== undefined && !text(value[key]))
      return 'Optical dates and notes must retain literal text';
  if (value.pd !== undefined && !literalValue(value.pd))
    return 'PD must retain literal value text and only explicitly stated units';
  for (const eye of value.eyes) {
    if (
      !object(eye) ||
      typeof eye.side !== 'string' ||
      !['right', 'left', 'both', 'unknown'].includes(eye.side) ||
      Object.keys(eye).some((key) => !['side', 'sideText', 'notes', ...valueFields].includes(key))
    )
      return 'Each optical entry requires a supported side; use unknown when unstated';
    for (const key of ['sideText', 'notes'])
      if (eye[key] !== undefined && !text(eye[key]))
        return 'Optical side labels and notes must be literal text';
    for (const key of valueFields)
      if (eye[key] !== undefined && !literalValue(eye[key]))
        return 'Optical values must retain literal value text and only explicitly stated units';
  }
  return null;
}

export function validClinicalFieldValue(
  key: keyof IntakeClinicalMapping,
  value: unknown,
): value is string | OpticalPrescription | null {
  return key === 'opticalPrescription'
    ? value === null || opticalPrescriptionProblem(value) === null
    : typeof value === 'string' && value.length <= (key === 'text' ? 1000000 : 10000);
}
