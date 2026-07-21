import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);

const environmentFilePattern = /(^|\/)\.env(?:\.|$)/;
const allowedExamplePattern = /(^|\/)\.env\.example$/;
const credentialPatterns = [
  ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['stripe-secret', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['sendgrid-key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/],
  ['embedded-url-credential', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/i],
];

const findings = [];

for (const file of trackedFiles) {
  if (environmentFilePattern.test(file) && !allowedExamplePattern.test(file)) {
    findings.push(`[tracked-env-file] ${file}`);
  }

  const contents = readFileSync(file);

  if (contents.includes(0)) {
    continue;
  }

  const lines = contents.toString('utf8').split('\n');

  for (const [rule, pattern] of credentialPatterns) {
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        findings.push(`[${rule}] ${file}:${index + 1}`);
      }
    });
  }
}

if (findings.length > 0) {
  console.error('Secret-safety check failed:');
  findings.forEach((finding) => console.error(`  ${finding}`));
  process.exitCode = 1;
} else {
  console.log('Secret-safety check passed');
}
