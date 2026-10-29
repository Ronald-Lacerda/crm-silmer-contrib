import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
