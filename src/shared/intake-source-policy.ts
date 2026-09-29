/** Eligibility is enforced by the host, never a document/model instruction. Strongly
 * recognized readable formats win over misleading filename hints. */
export function isRetainOnlyIntake(source: { filename: string; mimeType: string }): boolean {
  const mime = source.mimeType.toLowerCase().split(';')[0];
  if (/^(audio|video)\//.test(mime) || mime === 'application/dicom') return true;
  if (
    [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/zip',
      'application/json',
      'application/x-ndjson',
    ].includes(mime)
  )
    return false;
  return /\.(dcm|dicom|mp3|wav|m4a|aac|ogg|flac|mp4|mov|avi|webm)$/i.test(source.filename);
}
