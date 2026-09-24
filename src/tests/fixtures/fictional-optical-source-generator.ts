import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

export const OPTICAL_IMAGE_SOURCE_SYSTEM = 'Cobalt Harbor Optometry';
export const OPTICAL_PDF_SOURCE_SYSTEM = 'Sunward Optical Studio';

function escapePdf(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function pdfText(text: string, x: number, y: number, size = 11, bold = false) {
  return `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${escapePdf(text)}) Tj ET`;
}

function createPrescriptionPdf() {
  const stream = [
    '0.12 0.25 0.34 rg 0 708 612 84 re f',
    '1 1 1 rg',
    pdfText(OPTICAL_PDF_SOURCE_SYSTEM, 42, 754, 20, true),
    pdfText('Eyeglass prescription - independently fictional test record', 42, 732, 10),
    '0.12 0.25 0.34 rg',
    '0.12 0.25 0.34 RG 1.2 w 42 682 m 570 682 l S',
    pdfText('Patient', 42, 657, 9, true),
    pdfText('Elian Frost', 42, 638, 13),
    pdfText('Prescription ID', 330, 657, 9, true),
    pdfText('SUN-RX-1182', 330, 638, 13),
    pdfText('Prescribed', 42, 606, 9, true),
    pdfText('2026-11-08', 42, 587, 12),
    pdfText('Expires', 190, 606, 9, true),
    pdfText('2028-11-08', 190, 587, 12),
    pdfText('Prescription type', 365, 606, 9, true),
    pdfText('Spectacle', 365, 587, 12),
    '0.91 0.94 0.95 rg 42 526 528 31 re f',
    '0.12 0.25 0.34 rg',
    pdfText('EYE', 55, 537, 9, true),
    pdfText('SPH', 138, 537, 9, true),
    pdfText('CYL', 232, 537, 9, true),
    pdfText('AXIS', 326, 537, 9, true),
    pdfText('ADD', 420, 537, 9, true),
    pdfText('OD', 55, 493, 12, true),
    pdfText('-2.25', 138, 493, 12),
    pdfText('-1.00', 232, 493, 12),
    pdfText('003', 326, 493, 12),
    pdfText('+1.50', 420, 493, 12),
    '0.82 0.86 0.88 RG 0.8 w 42 476 m 570 476 l S',
    pdfText('OS', 55, 445, 12, true),
    pdfText('-1.75', 138, 445, 12),
    pdfText('-0.75', 232, 445, 12),
    pdfText('178', 326, 445, 12),
    pdfText('+1.50', 420, 445, 12),
    pdfText('Pupillary distance', 42, 388, 9, true),
    pdfText('064 mm', 42, 366, 14),
    pdfText('Source notation', 252, 388, 9, true),
    pdfText('SPH/CYL units are not printed on this prescription.', 252, 366, 10),
    '0.12 0.25 0.34 RG 1 w 42 303 m 570 303 l S',
    pdfText('Issued by Sunward Optical Studio', 42, 274, 11, true),
    pdfText('84 Lantern Walk, Northport - (555) 010-1182', 42, 253, 10),
    pdfText('Signed electronically by Dr. Tamsin Vale, OD', 42, 211, 10),
    pdfText(
      'This page is a generated fictional test fixture. It is not medical advice.',
      42,
      54,
      8,
    ),
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function createPrescriptionJpeg() {
  const canvas = createCanvas(1200, 800);
  const context = canvas.getContext('2d');
  context.fillStyle = '#f3eee3';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.translate(34, 28);
  context.rotate(-0.006);
  context.shadowColor = 'rgba(25, 35, 40, 0.22)';
  context.shadowBlur = 18;
  context.fillStyle = '#fffef9';
  context.fillRect(45, 34, 1090, 690);
  context.shadowColor = 'transparent';
  context.fillStyle = '#234b55';
  context.fillRect(45, 34, 1090, 105);
  context.fillStyle = '#ffffff';
  context.font = 'bold 31px Arial';
  context.fillText(OPTICAL_IMAGE_SOURCE_SYSTEM, 82, 83);
  context.font = '17px Arial';
  context.fillText('SPECTACLE PRESCRIPTION - FICTIONAL TEST RECORD', 82, 116);
  context.fillStyle = '#20333a';
  context.font = 'bold 15px Arial';
  context.fillText('PATIENT', 82, 178);
  context.fillText('PRESCRIPTION ID', 700, 178);
  context.font = '22px Arial';
  context.fillText('Mara Solace', 82, 207);
  context.fillText('CH-RX-4726', 700, 207);
  context.font = 'bold 15px Arial';
  context.fillText('PRESCRIBED', 82, 252);
  context.fillText('EXPIRES', 340, 252);
  context.fillText('TYPE', 598, 252);
  context.font = '21px Arial';
  context.fillText('04/05/26', 82, 282);
  context.fillText('04/05/28', 340, 282);
  context.fillText('Spectacle', 598, 282);
  context.fillStyle = '#e5eeee';
  context.fillRect(82, 326, 1015, 48);
  context.fillStyle = '#20333a';
  context.font = 'bold 17px Arial';
  ['EYE', 'SPH', 'CYL', 'AXIS', 'PD'].forEach((label, index) =>
    context.fillText(label, [101, 274, 477, 682, 884][index]!, 357),
  );
  context.font = 'bold 23px Arial';
  context.fillText('OD', 101, 423);
  context.fillText('OS', 101, 487);
  context.font = '23px Arial';
  ['+1.75', '-0.50', '007', '061.5 mm'].forEach((value, index) =>
    context.fillText(value, [274, 477, 682, 884][index]!, 423),
  );
  ['+1.25', '-0.25', '092'].forEach((value, index) =>
    context.fillText(value, [274, 477, 682][index]!, 487),
  );
  context.strokeStyle = '#c7d2d5';
  context.beginPath();
  context.moveTo(82, 446);
  context.lineTo(1097, 446);
  context.stroke();
  context.font = 'bold 15px Arial';
  context.fillText('SOURCE NOTATION', 82, 548);
  context.font = '18px Arial';
  context.fillText('SPH/CYL units are not printed on this prescription.', 82, 577);
  context.fillText('Numeric dates are printed exactly as supplied and require review.', 82, 606);
  context.font = 'bold 17px Arial';
  context.fillText('Issued by Cobalt Harbor Optometry', 82, 655);
  context.font = '15px Arial';
  context.fillText('19 Breakwater Row, Seaborne - (555) 010-4726', 82, 681);
  context.fillText('Signed electronically by Dr. Noor Finch, OD', 700, 681);
  context.restore();
  return canvas.toBuffer('image/jpeg', 90);
}

export function buildFictionalOpticalSources(outputDirectory: string) {
  const output = resolve(outputDirectory);
  mkdirSync(output, { recursive: true });
  const imageBytes = createPrescriptionJpeg();
  const pdfBytes = createPrescriptionPdf();
  const imagePath = join(output, 'fictional-cobalt-optical-prescription.jpg');
  const pdfPath = join(output, 'fictional-sunward-optical-prescription.pdf');
  writeFileSync(imagePath, imageBytes);
  writeFileSync(pdfPath, pdfBytes);
  return {
    image: {
      path: imagePath,
      filename: 'fictional-cobalt-optical-prescription.jpg',
      mimeType: 'image/jpeg',
      bytes: imageBytes,
      sha256: createHash('sha256').update(imageBytes).digest('hex'),
    },
    pdf: {
      path: pdfPath,
      filename: 'fictional-sunward-optical-prescription.pdf',
      mimeType: 'application/pdf',
      bytes: pdfBytes,
      sha256: createHash('sha256').update(pdfBytes).digest('hex'),
    },
  } as const;
}
