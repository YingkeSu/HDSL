/**
 * Verifies that a `sha256sum`-style checksum file is consumable by GNU
 * `sha256sum -c`.
 *
 * The Windows runner writes these files with PowerShell. `Set-Content` uses
 * CRLF and can add a BOM, neither of which GNU `sha256sum -c` tolerates, so the
 * production path must be checked at the byte level instead of trusting the
 * command that wrote it. The check rejects a BOM, any carriage return, a
 * missing final LF, malformed hash lines and (optionally) a filename mismatch.
 *
 * Usage: node scripts/verify-checksum-file.mjs <checksum-file> [expected-filename]
 * Exit codes: 0 = valid, 1 = violations, 2 = bad usage.
 */
import { readFileSync } from 'node:fs';

const BOM = [0xef, 0xbb, 0xbf];
const LINE = /^([0-9a-f]{64}) {2}(.+)$/;

/**
 * @param {string} filePath Checksum file produced by the build workflow.
 * @param {string} [expectedFilename] Optional filename every listed artifact must match.
 * @returns {string[]} One message per problem; empty means GNU-`sha256sum`-consumable.
 */
export const verifyChecksumFile = (filePath, expectedFilename) => {
  const errors = [];
  const bytes = readFileSync(filePath);
  if (bytes.length >= 3 && BOM.every((byte, index) => bytes[index] === byte)) {
    errors.push(`${filePath}: has a UTF-8 BOM, which sha256sum -c does not accept`);
  }
  if (bytes.includes(0x0d)) {
    errors.push(`${filePath}: contains CR (0x0D); sha256sum -c requires LF-only line endings`);
  }
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) {
    errors.push(`${filePath}: does not end with LF`);
  }
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split('\n').filter((line) => line !== '');
  if (lines.length === 0) {
    errors.push(`${filePath}: contains no checksum lines`);
  }
  for (const line of lines) {
    const match = LINE.exec(line);
    if (match === null) {
      errors.push(`${filePath}: malformed checksum line (expected '<64 hex>  <filename>')`);
      continue;
    }
    if (expectedFilename !== undefined && match[2] !== expectedFilename) {
      errors.push(`${filePath}: lists ${match[2]}, expected ${expectedFilename}`);
    }
  }
  return errors;
};

const [filePath, expectedFilename] = process.argv.slice(2);
if (filePath === undefined || filePath.trim() === '') {
  process.stderr.write('usage: node scripts/verify-checksum-file.mjs <checksum-file> [expected-filename]\n');
  process.exitCode = 2;
} else {
  const errors = verifyChecksumFile(filePath, expectedFilename);
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS: ${filePath} is LF-only, BOM-free and sha256sum-consumable\n`);
  }
}
