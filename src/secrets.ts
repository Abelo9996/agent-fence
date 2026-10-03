/**
 * Patterns for strings that look like credentials. Used both to flag commands and
 * writes that contain them and to redact them from the audit log.
 */
export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: "AWS access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { name: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: "Stripe key", re: /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "API key", re: /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "bearer token", re: /\b(Bearer|token)\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { name: "URL credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/gi },
  {
    name: "secret assignment",
    re: /\b[A-Za-z0-9_]*(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*\s*[=:]\s*["']?[^\s"'$]{8,}/gi,
  },
];

/** Names of the secret patterns found in text. */
export function findSecrets(text: string): string[] {
  const found: string[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) found.push(name);
    re.lastIndex = 0;
  }
  return found;
}

/** Replace anything that looks like a secret with a fixed marker, keeping a short prefix for recognition. */
export function redact(text: string): string {
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => {
      const eq = /^([A-Za-z0-9_]+\s*[=:]\s*["']?)/.exec(m);
      if (eq && /PASSWORD|PASSWD|SECRET|TOKEN|KEY/i.test(eq[1])) return eq[1] + "[REDACTED]";
      const url = /^([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)/i.exec(m);
      if (url) return url[1] + "[REDACTED]@";
      return m.slice(0, 4) + "[REDACTED]";
    });
  }
  return out;
}
