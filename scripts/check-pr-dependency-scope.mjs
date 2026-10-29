import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const manifest =
  /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const actionFile = /(?:^|\/)action\.ya?ml$|^\.github\/workflows\/.*\.ya?ml$/;

// Recognize only simple scalar uses keys. Unrecognized syntax is deliberately
// treated as a dependency change instead of guessing how YAML will parse it.
/** @param {string} content */
export function actionReferences(content) {
  const references = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (
      /(?:^|[\s:[{,])[&*][\w-]+/.test(line) ||
      /(?:^|[{,\s-])["'][^"']*\\[^"']*["']\s*:/.test(line)
    ) {
      return null;
    }
    if (!/uses/i.test(line)) continue;
    const match = line.match(/^\s*(?:-\s*)?uses:\s*(.*?)\s*(?:\s+#.*)?$/);
    if (!match) return null;
    let value = match[1];
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    if (
      !/^(?:[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[\w./-]+|docker:\/\/[^\s'"\\]+|\.\/[\w./-]+)$/.test(
        value,
      )
    )
      return null;
    references.push(value);
  }
  return references.sort();
}

/** @param {{path: string, status: string, before: string, after: string}[]} changes */
export function needsReview(changes) {
  for (const { path, status, before, after } of changes) {
    if (manifest.test(path)) return true;
    if (!actionFile.test(path)) continue;
    if (!['A', 'M', 'D'].includes(status)) return true;
    const oldRefs = actionReferences(before);
    const newRefs = actionReferences(after);
    if (
      !oldRefs ||
      !newRefs ||
      JSON.stringify(oldRefs) !== JSON.stringify(newRefs)
    )
      return true;
  }
  return false;
}

/** @param {string[]} args */
function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** @param {string | undefined} ref */
function commit(ref) {
  if (!ref || ref.startsWith('-'))
    throw new Error('A base and head commit are required');
  return git(
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ).trim();
}

/** @param {string | undefined} baseRef @param {string | undefined} headRef */
export function compareCommits(baseRef, headRef) {
  const base = commit(baseRef);
  const head = commit(headRef);
  const entries = git(
    'diff',
    '--name-status',
    '-z',
    '--no-renames',
    base,
    head,
    '--',
  ).split('\0');
  const changes = [];
  for (let i = 0; i < entries.length - 1; i += 2) {
    const status = entries[i];
    const path = entries[i + 1];
    if (!path || !status) throw new Error('Invalid git diff output');
    if (manifest.test(path)) return true;
    if (!actionFile.test(path)) continue;
    if (!['A', 'M', 'D'].includes(status)) return true;
    changes.push({
      path,
      status,
      before: status === 'A' ? '' : git('show', `${base}:${path}`),
      after: status === 'D' ? '' : git('show', `${head}:${path}`),
    });
  }
  return needsReview(changes);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const required = compareCommits(
      process.env.PR_BASE_SHA,
      process.env.PR_HEAD_SHA,
    );
    const output = `required=${required}\n`;
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, output);
    else process.stdout.write(output);
  } catch (error) {
    console.error(
      'Dependency scope comparison failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
}
