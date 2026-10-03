import { validateCheckerFiles } from './validate.ts';
console.log(`Validated ${validateCheckerFiles('dist/passkey-checker').length} checker-only files.`);
