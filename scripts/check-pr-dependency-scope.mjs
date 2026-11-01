import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

const manifest =
  /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const actionFile = /(?:^|\/)action\.ya?ml$|^\.github\/workflows\/.*\.ya?ml$/;
const workspacePath = /^(apps|modules)\/([a-z0-9-]+)$/;

/** @param {string} path @param {string} content */
function newLocalWorkspace(path, content) {
  if (!workspacePath.test(path.replace(/\/package\.json$/, ''))) return false;
  try {
    const value = JSON.parse(content);
    return (
      value.name === `@crm-silmer/${path.split('/')[1]}` &&
      value.version === '0.0.0' &&
      value.private === true &&
      value.type === 'module' &&
      typeof value.exports === 'string' &&
      /^\.\/src\/[a-zA-Z0-9/-]+\.js$/.test(value.exports) &&
      !value.exports.includes('..') &&
      Object.keys(value).every((key) =>
        ['name', 'version', 'private', 'type', 'exports'].includes(key),
      )
    );
  } catch {
    return false;
  }
}

/**
 * Verify each private workspace against its committed manifest and exact link.
 * @param {string} content
 * @param {(path: string) => string} readManifest
 */
function verifiedWorkspaces(content, readManifest) {
  const lock = JSON.parse(content);
  if (
    lock.lockfileVersion !== 3 ||
    !lock.packages?.[''] ||
    !Array.isArray(lock.packages[''].workspaces)
  )
    throw new Error('Unsupported lockfile');
  const packages = { ...lock.packages };
  /** @type {Map<string, {path: string, version: string, manifest: any}>} */
  const locals = new Map();
  for (const [path, value] of Object.entries(lock.packages)) {
    const match = path.match(workspacePath);
    if (!match) continue;
    const entry = /** @type {any} */ (value);
    const actual = JSON.parse(readManifest(`${path}/package.json`));
    if (
      !lock.packages[''].workspaces.includes(`${match[1]}/*`) ||
      actual.name !== `@crm-silmer/${match[2]}` ||
      actual.name !== entry.name ||
      actual.version !== entry.version ||
      actual.private !== true ||
      typeof actual.version !== 'string' ||
      !isDeepStrictEqual(lock.packages[`node_modules/${actual.name}`], {
        resolved: path,
        link: true,
      })
    )
      throw new Error('Unverified workspace');
    locals.set(actual.name, {
      path,
      version: actual.version,
      manifest: actual,
    });
  }
  return { lock, packages, locals };
}

/**
 * Remove only verified workspace records, links and exact local dependencies.
 * Keep every external package field, including integrity, resolved and flags.
 * @param {string} content
 * @param {(path: string) => string} readManifest
 */
function externalLock(content, readManifest) {
  const { lock, packages, locals } = verifiedWorkspaces(content, readManifest);
  for (const [name, local] of locals) {
    const entry = { ...packages[local.path] };
    delete entry.name;
    delete entry.version;
    if (entry.dependencies) {
      const dependencies = { ...entry.dependencies };
      for (const [dependency, version] of Object.entries(dependencies)) {
        if (
          locals.get(dependency)?.version === version &&
          local.manifest.dependencies?.[dependency] === version
        )
          delete dependencies[dependency];
      }
      if (Object.keys(dependencies).length) entry.dependencies = dependencies;
      else delete entry.dependencies;
    }
    if (Object.keys(entry).length) packages[local.path] = entry;
    else delete packages[local.path];
    delete packages[`node_modules/${name}`];
  }
  return { ...lock, packages };
}

/**
 * Existing workspace manifests may change only exact private workspace edges.
 * All other fields (scripts, external dependencies, flags, unknown metadata)
 * remain intact for comparison, and the lock must agree with the manifest.
 * @param {string} path
 * @param {string} content
 * @param {string} lockContent
 * @param {(path: string) => string} readManifest
 */
function externalManifest(path, content, lockContent, readManifest) {
  const workspace = path.replace(/\/package\.json$/, '');
  if (path !== `${workspace}/package.json` || !workspacePath.test(workspace))
    throw new Error('Unsupported workspace manifest');
  const { packages, locals } = verifiedWorkspaces(lockContent, readManifest);
  const actual = JSON.parse(content);
  const local = locals.get(actual.name);
  if (
    !local ||
    local.path !== workspace ||
    actual.version !== '0.0.0' ||
    actual.type !== 'module' ||
    !isDeepStrictEqual(actual, local.manifest) ||
    !isDeepStrictEqual(
      actual.dependencies ?? {},
      packages[workspace].dependencies ?? {},
    )
  )
    throw new Error('Unverified workspace manifest');
  const result = { ...actual };
  if (actual.dependencies !== undefined) {
    if (
      !actual.dependencies ||
      typeof actual.dependencies !== 'object' ||
      Array.isArray(actual.dependencies)
    )
      throw new Error('Invalid workspace dependencies');
    const dependencies = { ...actual.dependencies };
    for (const [name, version] of Object.entries(dependencies)) {
      if (version === '0.0.0' && locals.get(name)?.version === version)
        delete dependencies[name];
    }
    if (Object.keys(dependencies).length) result.dependencies = dependencies;
    else delete result.dependencies;
  }
  return result;
}

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

/**
 * @param {{path: string, status: string, before: string, after: string}[]} changes
 * @param {(path: string, side: 'before' | 'after') => string} readManifest
 */
export function needsReview(changes, readManifest = () => '') {
  /** @param {'before'|'after'} side */
  const readLock = (side) => {
    const changed = changes.find((entry) => entry.path === 'package-lock.json');
    if (changed && changed.status !== 'M')
      throw new Error('Unsupported lockfile change');
    return changed ? changed[side] : readManifest('package-lock.json', side);
  };
  for (const { path, status, before, after } of changes) {
    if (manifest.test(path)) {
      if (status === 'A' && newLocalWorkspace(path, after)) continue;
      if (
        status === 'M' &&
        workspacePath.test(path.replace(/\/package\.json$/, ''))
      ) {
        try {
          if (
            isDeepStrictEqual(
              externalManifest(path, before, readLock('before'), (file) =>
                readManifest(file, 'before'),
              ),
              externalManifest(path, after, readLock('after'), (file) =>
                readManifest(file, 'after'),
              ),
            )
          )
            continue;
        } catch {
          // Missing/inconsistent snapshots and unknown structures fail closed.
        }
      }
      if (path === 'package-lock.json' && status === 'M') {
        try {
          if (
            isDeepStrictEqual(
              externalLock(before, (file) => readManifest(file, 'before')),
              externalLock(after, (file) => readManifest(file, 'after')),
            )
          )
            continue;
        } catch {
          // Missing manifests, malformed JSON and unknown layouts fail closed.
        }
      }
      return true;
    }
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
    if (!manifest.test(path) && !actionFile.test(path)) continue;
    if (!['A', 'M', 'D'].includes(status)) return true;
    changes.push({
      path,
      status,
      before: status === 'A' ? '' : git('show', `${base}:${path}`),
      after: status === 'D' ? '' : git('show', `${head}:${path}`),
    });
  }
  return needsReview(changes, (path, side) =>
    git('show', `${side === 'before' ? base : head}:${path}`),
  );
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
