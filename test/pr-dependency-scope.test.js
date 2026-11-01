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

/** Existing app and target workspaces, with a new exact local dependency. */
function existingEdgeFixture() {
  const ownerPath = 'apps/api/package.json';
  const beforeManifest = {
    ...localManifest('api'),
    scripts: { start: 'node src/server.js' },
    dependencies: { example: '1.0.0', '@crm-silmer/contacts': '0.0.0' },
  };
  const afterManifest = structuredClone(beforeManifest);
  const beforeLock = /** @type {any} */ (lockFixture());
  beforeLock.packages['apps/api'] = {
    name: beforeManifest.name,
    version: beforeManifest.version,
    dependencies: { ...beforeManifest.dependencies },
  };
  beforeLock.packages['node_modules/@crm-silmer/api'] = {
    resolved: 'apps/api',
    link: true,
  };
  beforeLock.packages['modules/shipping'] = {
    name: '@crm-silmer/shipping',
    version: '0.0.0',
  };
  beforeLock.packages['node_modules/@crm-silmer/shipping'] = {
    resolved: 'modules/shipping',
    link: true,
  };
  const afterLock = structuredClone(beforeLock);
  /** @type {Record<string,any>} */ const beforeManifests = {
    ...structuredClone(manifests),
    [ownerPath]: beforeManifest,
  };
  /** @type {Record<string,any>} */ const afterManifests = {
    ...structuredClone(manifests),
    [ownerPath]: afterManifest,
  };
  return {
    ownerPath,
    beforeManifest,
    afterManifest,
    beforeLock,
    afterLock,
    beforeManifests,
    afterManifests,
    changes: () => [
      change(
        ownerPath,
        JSON.stringify(beforeManifest),
        JSON.stringify(afterManifest),
      ),
      lockChange(beforeLock, afterLock),
    ],
    /** @param {string} path @param {'before'|'after'} side */
    read: (path, side) =>
      JSON.stringify(
        path === 'package-lock.json'
          ? side === 'before'
            ? beforeLock
            : afterLock
          : (side === 'before' ? beforeManifests : afterManifests)[path],
      ),
    /** @param {string} [version] */
    addShipping(version = '0.0.0') {
      Object.assign(afterManifest.dependencies, {
        '@crm-silmer/shipping': version,
      });
      afterLock.packages['apps/api'].dependencies = {
        ...afterManifest.dependencies,
      };
    },
  };
}

test('existing private workspace may add or remove only an exact verified local dependency', () => {
  const added = existingEdgeFixture();
  added.addShipping();
  assert.equal(needsReview(added.changes(), added.read), false);
  assert.equal(needsReview(added.changes().toReversed(), added.read), false);
  const removed = existingEdgeFixture();
  delete (
    /** @type {any} */ (removed.afterManifest.dependencies)[
      '@crm-silmer/contacts'
    ]
  );
  removed.afterLock.packages['apps/api'].dependencies = {
    ...removed.afterManifest.dependencies,
  };
  assert.equal(needsReview(removed.changes(), removed.read), false);
});

test('local edges do not hide external versions, origins, integrity, flags or unknown lock metadata', () => {
  for (const [key, value] of Object.entries({
    version: '2.0.0',
    resolved: 'https://other.invalid/package.tgz',
    integrity: 'sha512-changed',
    dev: true,
    optional: true,
    hasInstallScript: true,
    unknown: 'unrecognized-metadata',
  })) {
    const fixture = existingEdgeFixture();
    fixture.addShipping();
    fixture.afterLock.packages['node_modules/example'][key] = value;
    assert.equal(needsReview(fixture.changes(), fixture.read), true, key);
  }
  for (const operation of ['add', 'remove', 'version']) {
    const fixture = existingEdgeFixture();
    fixture.addShipping();
    if (operation === 'add')
      Object.assign(fixture.afterManifest.dependencies, { external: '1.0.0' });
    else if (operation === 'remove')
      delete (/** @type {any} */ (fixture.afterManifest.dependencies).example);
    else fixture.afterManifest.dependencies.example = '2.0.0';
    fixture.afterLock.packages['apps/api'].dependencies = {
      ...fixture.afterManifest.dependencies,
    };
    assert.equal(needsReview(fixture.changes(), fixture.read), true, operation);
  }
});

test('local edges never exempt scripts, Actions, optional/dev dependencies or unknown manifest changes', () => {
  for (const extra of [
    { scripts: { start: 'node src/server.js', postinstall: 'node setup.js' } },
    { scripts: {} },
    { devDependencies: { '@crm-silmer/shipping': '0.0.0' } },
    { optionalDependencies: { '@crm-silmer/shipping': '0.0.0' } },
    { overrides: { example: '2.0.0' } },
    { unknown: 'unrecognized-metadata' },
  ]) {
    const fixture = existingEdgeFixture();
    fixture.addShipping();
    Object.assign(fixture.afterManifest, extra);
    assert.equal(
      needsReview(fixture.changes(), fixture.read),
      true,
      JSON.stringify(extra),
    );
  }
  const fixture = existingEdgeFixture();
  fixture.addShipping();
  assert.equal(
    needsReview(
      [
        ...fixture.changes(),
        change(workflow, ref, ref.replace('abc123', 'def456')),
      ],
      fixture.read,
    ),
    true,
  );
});

test('existing workspace edge fails closed for aliases, spoofed targets, missing snapshots and inconsistent lock', () => {
  for (const version of [
    '*',
    '^0.0.0',
    'npm:example@1.0.0',
    'file:../../modules/shipping',
    '1.0.0',
  ]) {
    const fixture = existingEdgeFixture();
    fixture.addShipping(version);
    assert.equal(needsReview(fixture.changes(), fixture.read), true, version);
  }
  /** @type {((fixture:ReturnType<typeof existingEdgeFixture>)=>void)[]} */
  const mutations = [
    (f) => {
      f.afterManifests['modules/shipping/package.json'].private = false;
    },
    (f) => {
      f.afterManifests['modules/shipping/package.json'].name =
        '@crm-silmer/impostor';
    },
    (f) => {
      delete f.afterManifests['modules/shipping/package.json'];
    },
    (f) => {
      f.afterLock.packages['node_modules/@crm-silmer/shipping'] = {
        ...externalPackage,
      };
    },
    (f) => {
      f.afterLock.packages['node_modules/@crm-silmer/shipping'].resolved =
        '../shipping';
    },
    (f) => {
      f.afterLock.packages[
        'node_modules/@crm-silmer/shipping'
      ].hasInstallScript = true;
    },
    (f) => {
      delete f.afterLock.packages['apps/api'].dependencies[
        '@crm-silmer/shipping'
      ];
    },
    (f) => {
      f.afterLock.lockfileVersion = 2;
    },
    (f) => {
      f.afterManifest.private = false;
    },
    (f) => {
      f.afterManifests[f.ownerPath] = {};
    },
  ];
  for (const mutate of mutations) {
    const fixture = existingEdgeFixture();
    fixture.addShipping();
    mutate(fixture);
    assert.equal(needsReview(fixture.changes(), fixture.read), true);
  }
  const fixture = existingEdgeFixture();
  fixture.addShipping();
  assert.equal(needsReview(fixture.changes()), true);
  const manifestOnly = existingEdgeFixture();
  manifestOnly.addShipping();
  manifestOnly.afterLock.packages['apps/api'].dependencies = {
    ...manifestOnly.beforeManifest.dependencies,
  };
  assert.equal(
    needsReview([manifestOnly.changes()[0]], manifestOnly.read),
    true,
  );
  fixture.afterLock.packages['apps/api'].dependencies = [];
  assert.equal(needsReview(fixture.changes(), fixture.read), true);
});

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
    const app = existingEdgeFixture().beforeManifest;
    lock.packages['apps/api'] = {
      name: app.name,
      version: app.version,
      dependencies: { ...app.dependencies },
    };
    lock.packages['node_modules/@crm-silmer/api'] = {
      resolved: 'apps/api',
      link: true,
    };
    save('apps/api/package.json', app);
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
    const localHead = commit();
    const local = run(base, localHead);
    assert.equal(local.status, 0, local.stderr);
    assert.equal(local.stdout, 'required=false\n');
    Object.assign(app.dependencies, { '@crm-silmer/shipping': '0.0.0' });
    lock.packages['apps/api'].dependencies = { ...app.dependencies };
    save('apps/api/package.json', app);
    save('package-lock.json', lock);
    const edgeHead = commit();
    for (const compareBase of [base, localHead]) {
      const internal = run(compareBase, edgeHead);
      assert.equal(internal.status, 0, internal.stderr);
      assert.equal(internal.stdout, 'required=false\n');
    }
    lock.packages['node_modules/example'].integrity = 'sha512-changed';
    save('package-lock.json', lock);
    const external = run(base, commit());
    assert.equal(external.status, 0, external.stderr);
    assert.equal(external.stdout, 'required=true\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
