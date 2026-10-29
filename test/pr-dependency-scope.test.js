import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { needsReview } from '../scripts/check-pr-dependency-scope.mjs';

const workflow = '.github/workflows/ci.yml';
const ref = 'steps:\n  - uses: actions/checkout@abc123\n';
/** @param {string} path */
const change = (path, before = '', after = '', status = 'M') => ({
  path,
  before,
  after,
  status,
});

test('only actual dependency changes require review', () => {
  /** @type {[string, ReturnType<typeof change>[], boolean][]} */
  const cases = [
    ['code only', [change('apps/index.js')], false],
    [
      'run and if only',
      [
        change(
          workflow,
          `${ref}  - run: echo old\n`,
          `${ref}  - if: success()\n    run: echo new\n`,
        ),
      ],
      false,
    ],
    [
      'nested manifest added',
      [change('apps/client/package.json', '', '{}', 'A')],
      true,
    ],
    ['root lock modified', [change('package-lock.json')], true],
    ['manifest deleted', [change('nested/yarn.lock', '', '', 'D')], true],
    [
      'checkout pin changed',
      [change(workflow, ref, ref.replace('abc123', 'def456'))],
      true,
    ],
    ['action added', [change(workflow, '', ref, 'A')], true],
    [
      'action removed',
      [change('actions/deploy/action.yml', ref, '', 'D')],
      true,
    ],
    [
      'quoted ref changed',
      [
        change(
          workflow,
          "- uses: 'actions/checkout@a'\n",
          '- uses: "actions/checkout@b"\n',
        ),
      ],
      true,
    ],
    [
      'flow mapping',
      [
        change(
          workflow,
          '- {uses: actions/checkout@a}\n',
          '- {uses: actions/checkout@b}\n',
        ),
      ],
      true,
    ],
    [
      'multiline uses',
      [
        change(
          workflow,
          'uses: >\n  actions/checkout@a\n',
          'uses: >\n  actions/checkout@b\n',
        ),
      ],
      true,
    ],
    [
      'docker ref changed',
      [
        change(
          'action.yaml',
          'uses: docker://image:one\n',
          'uses: docker://image:two\n',
        ),
      ],
      true,
    ],
    [
      'anchor',
      [change(workflow, 'ref: &pin actions/checkout@a\nuses: *pin\n', ref)],
      true,
    ],
    [
      'escaped ref',
      [change(workflow, 'uses: "actions\\/checkout@a"\n', ref)],
      true,
    ],
    [
      'dynamic ref',
      [change(workflow, 'uses: ${{ inputs.action }}\n', ref)],
      true,
    ],
  ];
  for (const [name, changes, expected] of cases)
    assert.equal(needsReview(changes), expected, name);
});

test('invalid git comparison fails closed', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/check-pr-dependency-scope.mjs'],
    {
      env: {
        ...process.env,
        PR_BASE_SHA: 'invalid-ref-not-found',
        PR_HEAD_SHA: 'HEAD',
        GITHUB_OUTPUT: '',
      },
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /required=false/);
});

const localManifest = (name = 'shipping') => ({
  name: `@crm-silmer/${name}`,
  version: '0.0.0',
  private: true,
  type: 'module',
  exports: './src/index.js',
});
const externalPackage = {
  version: '1.0.0',
  resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
  integrity: 'sha512-example',
};
function lockFixture() {
  return {
    name: 'fixture',
    version: '0.0.0',
    lockfileVersion: 3,
    packages: {
      '': { workspaces: ['apps/*', 'modules/*'] },
      'modules/contacts': { name: '@crm-silmer/contacts', version: '0.0.0' },
      'modules/n8n-integration': {
        name: '@crm-silmer/n8n-integration',
        version: '0.0.0',
      },
      'node_modules/@crm-silmer/contacts': {
        resolved: 'modules/contacts',
        link: true,
      },
      'node_modules/@crm-silmer/n8n-integration': {
        resolved: 'modules/n8n-integration',
        link: true,
      },
      'node_modules/example': { ...externalPackage },
    },
  };
}
/** @type {Record<string, any>} */
const manifests = {
  'modules/contacts/package.json': localManifest('contacts'),
  'modules/n8n-integration/package.json': {
    ...localManifest('n8n-integration'),
    dependencies: { '@crm-silmer/contacts': '0.0.0' },
  },
  'modules/shipping/package.json': localManifest(),
};
/** @param {string} path */
const readManifest = (path) => JSON.stringify(manifests[path]);
const newWorkspace = () =>
  change(
    'modules/shipping/package.json',
    '',
    readManifest('modules/shipping/package.json'),
    'A',
  );
/** @param {any} before @param {any} after */
const lockChange = (before, after) =>
  change('package-lock.json', JSON.stringify(before), JSON.stringify(after));

test('local workspace registration and existing internal dependency sync need no external review', () => {
  const before = lockFixture();
  const after = JSON.parse(JSON.stringify(before));
  after.packages['modules/shipping'] = {
    name: '@crm-silmer/shipping',
    version: '0.0.0',
  };
  after.packages['node_modules/@crm-silmer/shipping'] = {
    resolved: 'modules/shipping',
    link: true,
  };
  after.packages['modules/n8n-integration'].dependencies = {
    '@crm-silmer/contacts': '0.0.0',
  };
  assert.equal(
    needsReview([newWorkspace(), lockChange(before, after)], readManifest),
    false,
  );
});

test('new workspace manifests with dependencies, scripts or unknown settings still need review', () => {
  for (const extra of [
    { dependencies: { example: '1.0.0' } },
    { scripts: { postinstall: 'node setup.js' } },
    { overrides: { example: '2.0.0' } },
    { optionalDependencies: { example: '1.0.0' } },
    { bin: './src/index.js' },
    { exports: '../outside.js' },
    { private: false },
  ]) {
    const added = newWorkspace();
    added.after = JSON.stringify({ ...localManifest(), ...extra });
    assert.equal(needsReview([added]), true, JSON.stringify(extra));
  }
  assert.equal(
    needsReview([
      change(
        'modules/shipping/package.json',
        '{}',
        readManifest('modules/shipping/package.json'),
      ),
    ]),
    true,
  );
});

test('every external lock field remains reviewed, including changes mixed with a local workspace', () => {
  for (const [key, value] of Object.entries({
    version: '2.0.0',
    resolved: 'https://other.invalid/package.tgz',
    integrity: 'sha512-changed',
    dev: true,
    optional: true,
    hasInstallScript: true,
  })) {
    const before = lockFixture();
    const after = JSON.parse(JSON.stringify(before));
    after.packages['node_modules/example'][key] = value;
    assert.equal(
      needsReview([newWorkspace(), lockChange(before, after)], readManifest),
      true,
      key,
    );
  }
});

test('local-looking registry packages and unverified workspace dependencies require review', () => {
  const before = lockFixture();
  const after = JSON.parse(JSON.stringify(before));
  after.packages['node_modules/@crm-silmer/registry-package'] = {
    ...externalPackage,
  };
  assert.equal(needsReview([lockChange(before, after)], readManifest), true);
  for (const version of ['*', '^0.0.0', 'npm:example@1.0.0', '1.0.0']) {
    const changed = JSON.parse(JSON.stringify(before));
    changed.packages['modules/n8n-integration'].dependencies = {
      '@crm-silmer/contacts': version,
    };
    assert.equal(
      needsReview([lockChange(before, changed)], readManifest),
      true,
      version,
    );
  }
});

test('external additions, removals and unknown local lock metadata remain reviewable', () => {
  const before = lockFixture();
  /** @type {((lock: any) => void)[]} */
  const mutations = [
    (lock) => {
      lock.packages['node_modules/new-package'] = { ...externalPackage };
    },
    (lock) => {
      delete lock.packages['node_modules/example'];
    },
    (lock) => {
      lock.packages['modules/contacts'].hasInstallScript = true;
    },
  ];
  for (const mutate of mutations) {
    const after = JSON.parse(JSON.stringify(before));
    mutate(after);
    assert.equal(needsReview([lockChange(before, after)], readManifest), true);
  }
});

test('invalid locks, missing manifests and unsafe or modified links fail closed', () => {
  const before = lockFixture();
  for (const link of [
    { resolved: '../contacts', link: true },
    { resolved: 'modules/contacts', link: true, hasInstallScript: true },
    { resolved: 'modules/contacts', link: false },
    { ...externalPackage },
  ]) {
    const after = JSON.parse(JSON.stringify(before));
    after.packages['node_modules/@crm-silmer/contacts'] = link;
    assert.equal(needsReview([lockChange(before, after)], readManifest), true);
  }
  assert.equal(needsReview([lockChange(before, before)]), true);
  assert.equal(
    needsReview([change('package-lock.json', '{', '{}')], readManifest),
    true,
  );
  assert.equal(
    needsReview(
      [lockChange(before, { ...before, lockfileVersion: 2 })],
      readManifest,
    ),
    true,
  );
});

test('CLI reads committed workspace manifests and reports an external change after a local-only change', () => {
  const directory = mkdtempSync(join(tmpdir(), 'crm-dependency-scope-'));
  /** @param {string[]} args */
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  /** @param {string} path @param {any} content */
  const save = (path, content) => {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), JSON.stringify(content));
  };
  const commit = () => {
    git(['add', '.']);
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    return git(['rev-parse', 'HEAD']);
  };
  /** @param {string} base @param {string} head */
  const run = (base, head) =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('../scripts/check-pr-dependency-scope.mjs', import.meta.url),
        ),
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PR_BASE_SHA: base,
          PR_HEAD_SHA: head,
          GITHUB_OUTPUT: '',
        },
      },
    );
  try {
    git(['init', '-q']);
    const lock = /** @type {any} */ (lockFixture());
    save('package-lock.json', lock);
    for (const [path, value] of Object.entries(manifests)) {
      if (!path.includes('/shipping/')) save(path, value);
    }
    const base = commit();
    save('modules/shipping/package.json', localManifest());
    lock.packages['modules/shipping'] = {
      name: '@crm-silmer/shipping',
      version: '0.0.0',
    };
    lock.packages['node_modules/@crm-silmer/shipping'] = {
      resolved: 'modules/shipping',
      link: true,
    };
    lock.packages['modules/n8n-integration'].dependencies = {
      '@crm-silmer/contacts': '0.0.0',
    };
    save('package-lock.json', lock);
    const local = run(base, commit());
    assert.equal(local.status, 0, local.stderr);
    assert.equal(local.stdout, 'required=false\n');
    lock.packages['node_modules/example'].integrity = 'sha512-changed';
    save('package-lock.json', lock);
    const external = run(base, commit());
    assert.equal(external.status, 0, external.stderr);
    assert.equal(external.stdout, 'required=true\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
