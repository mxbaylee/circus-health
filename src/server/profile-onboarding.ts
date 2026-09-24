import { HttpError } from './database.ts';
import { validOnboardingBirthDate, validOnboardingFullName } from '../shared/self-identity.ts';

export function onboardingIdentity(input: { fullName?: unknown; birthDate?: unknown }): {
  fullName: string;
  birthDate: string;
} {
  if (!validOnboardingFullName(input.fullName))
    throw new HttpError(
      400,
      'PROFILE_FULL_NAME',
      'Enter the full name used on your health records',
    );
  if (!validOnboardingBirthDate(input.birthDate))
    throw new HttpError(
      400,
      'PROFILE_BIRTH_DATE',
      'Enter a complete valid date of birth that is not in the future',
    );
  return { fullName: input.fullName.trim(), birthDate: input.birthDate };
}
