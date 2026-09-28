/**
 * ExcludedPaths - Centralized exception list for generated/dependency directories.
 *
 * WHY THIS EXISTS:
 * Package installs (`npm install` → node_modules, `pip install` → venv/.venv)
 * create thousands of files on disk. The FileSystemWatcher treats closed-file
 * modifications as AI agent mode (HIGH confidence), so a single install bursts
 * thousands of fake AI events with huge LOC. These paths are never user-authored
 * code, so they are hard-ignored at every layer (collection, aggregation,
 * reporting).
 *
 * This module is intentionally dependency-free (no vscode import) so it can be
 * used from trackers, collectors, assignment policy, and tests.
 */

/**
 * Directory names that are always excluded, matched as exact path segments
 * (case-insensitive). Covers JS/TS, Python, and common build outputs.
 */
export const DEFAULT_EXCLUDED_DIR_SEGMENTS: readonly string[] = [
  // JS/TS dependencies
  'node_modules',
  'bower_components',
  '.npm',
  // Python environments & caches
  'venv',
  '.venv',
  'env',
  '.env-venv',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'site-packages',
  // Version control / VCS metadata
  '.git',
  '.hg',
  '.svn',
  // Build outputs & coverage (v1 defaults per product decision)
  'dist',
  'build',
  'out',
  'coverage',
  '.nyc_output',
  '.next',
  '.nuxt',
  'target',
  'vendor',
  // IDE / editor metadata
  '.idea',
  '.vs',
];

/**
 * Glob patterns mirroring the segment list, for assignment policies
 * (PolicyEngine/AssignmentManager use glob matching) and the user-facing
 * `codePause.excludedGlobs` setting.
 */
export const DEFAULT_EXCLUDED_GLOBS: readonly string[] = [
  '**/node_modules/**',
  '**/bower_components/**',
  '**/.npm/**',
  '**/venv/**',
  '**/.venv/**',
  '**/env/**',
  '**/__pycache__/**',
  '**/.tox/**',
  '**/.mypy_cache/**',
  '**/.pytest_cache/**',
  '**/.ruff_cache/**',
  '**/site-packages/**',
  '**/.git/**',
  '**/.hg/**',
  '**/.svn/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/.nyc_output/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/target/**',
  '**/vendor/**',
  '**/.idea/**',
  '**/.vs/**',
  '**/*.pyc',
  '**/*.pyo',
  '**/*.min.js',
  '**/*.bundle.js',
  '**/*.map',
];

/**
 * Normalize a file path for comparison: backslashes → forward slashes,
 * lowercase. Returns empty string for falsy input.
 */
export function normalizePathForExclusion(filePath: string | undefined | null): string {
  if (!filePath) {
    return '';
  }
  return filePath.replace(/\\/g, '/').toLowerCase();
}

/**
 * Check whether a file path falls under an excluded directory segment.
 * Matches exact segments only, so `my-venv-backup/file.ts` is NOT excluded
 * but `proj/venv/lib/x.py` IS.
 */
export function isExcludedBySegment(
  filePath: string | undefined | null,
  segments: readonly string[] = DEFAULT_EXCLUDED_DIR_SEGMENTS
): boolean {
  const normalized = normalizePathForExclusion(filePath);
  if (!normalized) {
    return false;
  }
  const parts = normalized.split('/').filter(Boolean);
  const segmentSet = new Set(segments.map((s) => s.toLowerCase()));
  return parts.some((part) => segmentSet.has(part));
}

/**
 * Minimal glob matcher supporting `**`, `*`, `?` (same semantics as
 * PolicyEngine/AssignmentManager). Used for user-supplied extra globs.
 */
export function matchExclusionGlob(filePath: string, glob: string): boolean {
  const normalizedPath = normalizePathForExclusion(filePath);
  const normalizedGlob = glob.replace(/\\/g, '/').toLowerCase();
  const regex = new RegExp(
    '^' +
      normalizedGlob
        .replace(/\*\*/g, '<<<ANYDEPTH>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<ANYDEPTH>>>/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  );
  return regex.test(normalizedPath);
}

/**
 * Master check: true if the path should be hard-ignored.
 *
 * - Always applies the default segment list (fast path, no regex).
 * - Also matches `*.pyc`-style file patterns and any caller-supplied
 *   extra globs (e.g. user `codePause.excludedGlobs`).
 */
export function isExcludedFile(
  filePath: string | undefined | null,
  extraGlobs: readonly string[] = []
): boolean {
  if (!filePath) {
    return false;
  }
  if (isExcludedBySegment(filePath)) {
    return true;
  }
  const normalized = normalizePathForExclusion(filePath);
  // Generated-file suffixes that segment matching cannot catch
  if (
    normalized.endsWith('.pyc') ||
    normalized.endsWith('.pyo') ||
    normalized.endsWith('.min.js') ||
    normalized.endsWith('.bundle.js') ||
    normalized.endsWith('.map')
  ) {
    return true;
  }
  for (const glob of extraGlobs) {
    if (glob && matchExclusionGlob(filePath, glob)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Anti-evasion: validation of user-supplied extra globs
//
// Threat model: the extension runs on student hardware, so a determined
// student can always disable it (visible via tracking gaps). What we MUST
// prevent is casual evasion through the settings file, e.g. adding
// `**/src/**` or `**` to `codePause.excludedGlobs` to hide real work.
// Defense in depth:
//   1. validateCustomExclusions() rejects universe-matching patterns here.
//   2. MetricsCollector ignores ALL custom globs while an assignment is
//      active (instructor policy wins; see getEffectiveExcludedGlobs).
//   3. Every change is written to the exclusion_audit table and embedded in
//      assignment reports (tamper-evident).
// ---------------------------------------------------------------------------

/** Maximum number of user-supplied extra globs (bounds abuse surface). */
export const MAX_CUSTOM_EXCLUSIONS = 50;

/** Maximum length of a single user-supplied glob. */
export const MAX_CUSTOM_EXCLUSION_LENGTH = 200;

/**
 * Patterns that match everything (or everything at the workspace root).
 * These are never legitimate exclusions and are always rejected.
 */
export const BLOCKED_UNIVERSE_PATTERNS: readonly string[] = [
  '**',
  '*',
  '**/*',
  '**/**',
  '.',
  '/',
  './**',
];

/**
 * Validate user-supplied extra globs. Returns the valid subset plus rejection
 * reasons for the rest. Rejected globs are never applied.
 */
export function validateCustomExclusions(
  globs: readonly string[] | undefined | null
): { valid: string[]; rejected: Array<{ glob: string; reason: string }> } {
  const valid: string[] = [];
  const rejected: Array<{ glob: string; reason: string }> = [];

  if (!globs) {
    return { valid, rejected };
  }

  const seen = new Set<string>();
  for (const raw of globs) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      rejected.push({ glob: String(raw), reason: 'empty exclusion' });
      continue;
    }
    const glob = raw.trim();
    const normalized = glob.replace(/\\/g, '/').toLowerCase();

    if (seen.has(normalized)) {
      rejected.push({ glob, reason: 'duplicate exclusion' });
      continue;
    }
    seen.add(normalized);

    if (BLOCKED_UNIVERSE_PATTERNS.includes(normalized)) {
      rejected.push({ glob, reason: 'matches everything - not a valid exclusion' });
      continue;
    }
    if (glob.length > MAX_CUSTOM_EXCLUSION_LENGTH) {
      rejected.push({ glob, reason: `exceeds ${MAX_CUSTOM_EXCLUSION_LENGTH} characters` });
      continue;
    }
    valid.push(glob);
  }

  if (valid.length > MAX_CUSTOM_EXCLUSIONS) {
    const overflow = valid.splice(MAX_CUSTOM_EXCLUSIONS);
    for (const glob of overflow) {
      rejected.push({ glob, reason: `exceeds ${MAX_CUSTOM_EXCLUSIONS} exclusions` });
    }
  }

  return { valid, rejected };
}

/**
 * Sanitize user-supplied extra globs down to the safe subset.
 * Logs rejections so evasion attempts are visible in extension logs.
 */
export function sanitizeCustomExclusions(
  globs: readonly string[] | undefined | null
): string[] {
  const { valid, rejected } = validateCustomExclusions(globs);
  for (const { glob, reason } of rejected) {
    console.warn(`[CodePause:exclusions] Ignoring invalid exclusion "${glob}": ${reason}`);
  }
  return valid;
}
