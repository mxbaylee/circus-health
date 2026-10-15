/** Worker-safe source pin identity; the stored value is validated separately. */
export const intakeSourcePinKey = (intakeId: string) => `intake_source_pin:v1:${intakeId}`;
