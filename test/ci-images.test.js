import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../', import.meta.url);

/** @param {string} path */
async function text(path) {
  return readFile(new URL(path, rootUrl), 'utf8');
}

/** @param {string} path */
async function json(path) {
  return JSON.parse(await text(path));
}

test('pins the approved browser and accessibility test dependencies', async () => {
  const packageJson = await json('package.json');

  assert.equal(packageJson.devDependencies['@playwright/test'], '1.62.1');
  assert.equal(packageJson.devDependencies['@axe-core/playwright'], '4.13.0');
  assert.equal(packageJson.scripts['test:e2e'], 'playwright test');
  assert.match(packageJson.scripts.validate, /npm test/u);
});

test('builds minimal non-root images from immutable official bases', async () => {
  for (const path of [
    'docker/edge-web.Dockerfile',
    'docker/runtime.Dockerfile',
  ]) {
    const dockerfile = await text(path);
    const fromLines = dockerfile
      .split('\n')
      .filter((line) => line.startsWith('FROM '));

    assert.ok(fromLines.length > 0, `${path} must declare a base image`);
    assert.ok(
      fromLines.every((line) => /@sha256:[a-f0-9]{64}(?:\s|$)/u.test(line)),
      `${path} must pin every base by digest`,
    );
    assert.doesNotMatch(dockerfile, /\blatest\b/u);
    assert.match(dockerfile, /HEALTHCHECK/u);
    assert.match(dockerfile, /USER (?:nginx|node)/u);
  }

  assert.match(await text('docker/edge-web.Dockerfile'), /\/healthz/u);
});

test('routes the edge proxy to the canonical API service', async () => {
  const nginx = await text('docker/nginx.conf');

  assert.match(nginx, /http:\/\/silmer-api:3000/u);
  assert.doesNotMatch(nginx, /http:\/\/api:3000/u);
  assert.match(nginx, /Content-Security-Policy/u);
  assert.match(nginx, /Strict-Transport-Security/u);
  assert.match(nginx, /X-Content-Type-Options "nosniff"/u);
  assert.match(nginx, /X-Frame-Options "DENY"/u);
});

test('T138/OLIST-T04: OAuth codes and state never enter edge access/error logs', async () => {
  const nginx = await text('docker/nginx.conf');
  const format = /log_format crm_safe '([^']+)';/u.exec(nginx);
  assert.ok(format);
  assert.doesNotMatch(format[1], /\$(?:request(?:_uri)?|args|http_referer)\b/u);
  assert.match(nginx, /access_log \/dev\/stdout crm_safe;/u);
  for (const path of ['melhor-envio', 'olist']) {
    const callback = new RegExp(`location = /${path} \\{([^}]+)\\}`, 'u').exec(
      nginx,
    );
    assert.ok(callback, `/${path} needs an exact callback boundary`);
    assert.match(callback[1], /access_log off;/u);
    assert.match(callback[1], /error_log \/dev\/null;/u);
    assert.match(callback[1], /try_files \/index\.html =404;/u);
    assert.ok(nginx.includes(`~^/${path}(?:\\?|$) "private, no-store";`));
  }
  assert.match(nginx, /Referrer-Policy "no-referrer" always;/u);
});

test('packages every runtime workspace required by the API', async () => {
  const dockerfile = await text('docker/runtime.Dockerfile');
  const buildScript = await text('scripts/build.mjs');
  const healthcheck = await text('scripts/runtime-healthcheck.mjs');

  assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm/u);
  assert.match(dockerfile, /COPY.+scripts\/runtime-healthcheck\.mjs/u);
  assert.match(dockerfile, /CMD \["node", "runtime-healthcheck\.mjs"/u);
  assert.match(healthcheck, /apps\/worker\/src\/worker\.js/u);
  assert.match(healthcheck, /\/api\/health\/live/u);

  /** @type {Map<string, { directory: string, manifest: any }>} */
  const workspaceModules = new Map();
  for (const entry of await readdir(new URL('modules/', rootUrl), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = `modules/${entry.name}/package.json`;
    let manifest;
    try {
      manifest = await json(manifestPath);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    workspaceModules.set(manifest.name, { directory: entry.name, manifest });
  }

  for (const { directory } of workspaceModules.values()) {
    assert.equal(
      dockerfile.match(
        new RegExp(`COPY modules/${directory}/package\\.json`, 'gu'),
      )?.length,
      2,
      `both dependency stages need the ${directory} workspace manifest`,
    );
  }

  const pending = [
    await json('apps/api/package.json'),
    await json('apps/worker/package.json'),
  ];
  /** @type {Set<string>} */
  const runtimeModuleSet = new Set();
  while (pending.length > 0) {
    const manifest = pending.pop();
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const workspace = workspaceModules.get(dependency);
      if (!workspace || runtimeModuleSet.has(workspace.directory)) continue;
      runtimeModuleSet.add(workspace.directory);
      pending.push(workspace.manifest);
    }
  }
  const runtimeModules = [...runtimeModuleSet].sort();

  for (const moduleName of ['database', 'olist', 'orders', 'shared']) {
    assert.ok(
      runtimeModules.includes(moduleName),
      `${moduleName} must be resolved as a runtime workspace dependency`,
    );
  }
  for (const moduleName of runtimeModules) {
    assert.match(
      buildScript,
      new RegExp(`modules/${moduleName}/src`, 'u'),
      `${moduleName} sources must be copied into the runtime`,
    );
    assert.match(
      buildScript,
      new RegExp(`modules/${moduleName}/package\\.json`, 'u'),
      `${moduleName} manifest must be copied into the runtime`,
    );
  }
  assert.doesNotMatch(buildScript, /modules\/deals-pipeline\/src/u);
  assert.doesNotMatch(buildScript, /modules\/qualification\/src/u);

  assert.match(buildScript, /modules\/database\/migrations/u);
});

test('scans each local OCI layout before its only registry publication', async () => {
  const workflow = await text('.github/workflows/ci.yml');
  const actionRefs = [
    ...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gmu),
  ].map(([, ref]) => ref);

  assert.ok(actionRefs.length >= 8);
  assert.ok(
    actionRefs.every((ref) => /@[a-f0-9]{40}$/u.test(ref)),
    'all third-party Actions must use a full commit SHA',
  );
  assert.equal(
    actionRefs.filter((ref) => ref.startsWith('docker/build-push-action@'))
      .length,
    1,
  );
  assert.match(workflow, /npm ci/u);
  assert.match(
    workflow,
    /actions\/cache@5a3ec84eff668545956fd18022155c47e93e2684/u,
  );
  assert.match(workflow, /path:\s*~\/\.cache\/ms-playwright/u);
  assert.match(
    workflow,
    /key:\s*playwright-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/u,
  );
  assert.match(workflow, /npm run validate/u);
  assert.match(workflow, /postgres:17-alpine@sha256:[a-f0-9]{64}/u);
  assert.match(workflow, /TEST_DATABASE_URL:/u);
  assert.match(workflow, /npm run test:identity:live/u);
  assert.match(
    (await json('package.json')).scripts['test:identity:live'],
    /--test-concurrency=1/u,
  );
  assert.match(workflow, /npm run test:e2e/u);
  assert.match(workflow, /npm audit --audit-level=high/u);
  assert.match(workflow, /git diff --check/u);
  assert.doesNotMatch(
    workflow,
    /paths-ignore:\s+- graphify-out\/\*\*/u,
    'Graphify-only commits must still produce required branch checks',
  );
  assert.match(workflow, /timeout-minutes:\s*30/u);
  assert.match(workflow, /timeout-minutes:\s*45/u);
  assert.equal(workflow.match(/version:\s*v0\.36\.1/gu)?.length, 1);
  assert.match(workflow, /image=moby\/buildkit@sha256:[a-f0-9]{64}/u);
  assert.match(
    workflow,
    /cache-from:\s*type=gha,scope=\$\{\{ matrix\.image \}\}/u,
  );
  assert.match(
    workflow,
    /cache-to:\s*type=gha,mode=max,scope=\$\{\{ matrix\.image \}\}/u,
  );
  assert.match(
    workflow,
    /images:[\s\S]+permissions:\s+contents:\s+read\s+packages:\s+write/u,
  );
  assert.match(workflow, /aquasecurity\/trivy-action@[a-f0-9]{40}/u);
  assert.match(
    workflow,
    /RELEASE_TAG: ghcr\.io\/\$\{\{ github\.repository \}\}\/\$\{\{ matrix\.image \}\}:\$\{\{ github\.sha \}\}/u,
  );
  const buildIndex = workflow.indexOf('Build one local OCI layout');
  const scanIndex = workflow.indexOf('Scan local OCI layout with Trivy');
  const publishIndex = workflow.indexOf(
    'Publish the scanned OCI layout without rebuilding',
  );
  assert.ok(buildIndex >= 0 && buildIndex < scanIndex);
  assert.ok(scanIndex < publishIndex);
  assert.match(
    workflow,
    /outputs:\s*type=oci,dest=\/tmp\/\$\{\{ matrix\.image \}\}-oci,tar=false/u,
  );
  assert.match(workflow, /input:\s*\/tmp\/\$\{\{ matrix\.image \}\}-oci/u);
  assert.doesNotMatch(workflow, /\/candidates\//u);
  assert.match(workflow, /skopeo copy --all --preserve-digests/u);
  assert.match(
    workflow,
    /EXPECTED_DIGEST:\s*\$\{\{ steps\.build\.outputs\.digest \}\}/u,
  );
  assert.match(workflow, /test "\$release_digest" = "\$EXPECTED_DIGEST"/u);
  assert.match(workflow, /docker buildx imagetools inspect/u);
  assert.match(workflow, /sbom:\s*\$\{\{ github\.event_name == 'push' \}\}/u);
  assert.match(
    workflow,
    /provenance:\s*\$\{\{ github\.event_name == 'push' && 'mode=max' \|\| false \}\}/u,
  );
  assert.doesNotMatch(workflow, /:\s*latest\b|:latest\b/u);
});

test('reports required image checks even when a PR does not affect images', async () => {
  const workflow = await text('.github/workflows/ci.yml');
  const imagesJob = workflow.slice(
    workflow.indexOf('\n  images:'),
    workflow.indexOf('\n    steps:', workflow.indexOf('\n  images:')),
  );
  const imageSteps = workflow
    .slice(workflow.indexOf('\n    steps:', workflow.indexOf('\n  images:')))
    .split(/\n {6}- name: /u)
    .slice(1);

  // A skipped matrix job never expands its name, so the required
  // "Build and scan <image>" checks would stay pending forever.
  assert.doesNotMatch(
    imagesJob,
    /^ {4}if:/mu,
    'images job must always run so its matrix check names are reported',
  );
  assert.ok(imageSteps.length >= 8);
  for (const step of imageSteps) {
    assert.match(
      step,
      /if: .*env\.IMAGE_BUILD_REQUIRED == 'true'/u,
      `image step must be gated by the image scope: ${step.split('\n')[0]}`,
    );
  }
  assert.match(
    imagesJob,
    /IMAGE_BUILD_REQUIRED: \$\{\{ needs\.quality\.outputs\.image_build_required \}\}/u,
  );
});

test('promotes one approved SHA as identical dev and hml digest references', async () => {
  const workflow = await text('.github/workflows/promote-approved-sha.yml');

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /approved_sha:/u);
  assert.match(workflow, /environment:\s*t00-2-promotion/u);
  assert.match(workflow, /timeout-minutes:\s*10/u);
  assert.equal(workflow.match(/version:\s*v0\.36\.1/gu)?.length, 1);
  assert.match(workflow, /image=moby\/buildkit@sha256:[a-f0-9]{64}/u);
  assert.match(workflow, /actions:\s*read/u);
  assert.match(workflow, /gh api --method GET/u);
  assert.match(workflow, /head_sha="\$APPROVED_SHA"/u);
  assert.match(workflow, /\.conclusion == "success"/u);
  assert.match(workflow, /\.head_branch == "master"/u);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(workflow, /gh run download "\$CI_RUN_ID"/u);
  assert.match(workflow, /digest-edge-web-\$APPROVED_SHA/u);
  assert.match(workflow, /digest-runtime-\$APPROVED_SHA/u);
  assert.match(workflow, /test "\$edge_registry_digest" = "\$edge_digest"/u);
  assert.match(
    workflow,
    /test "\$runtime_registry_digest" = "\$runtime_digest"/u,
  );
  assert.match(workflow, /docker buildx imagetools inspect/u);
  assert.match(workflow, /edge_ref="\$REGISTRY_ROOT\/edge-web@\$edge_digest"/u);
  assert.match(
    workflow,
    /runtime_ref="\$REGISTRY_ROOT\/runtime@\$runtime_digest"/u,
  );
  assert.match(workflow, /EDGE_WEB_DEV=%s.+"\$edge_ref"/u);
  assert.match(workflow, /EDGE_WEB_HML=%s.+"\$edge_ref"/u);
  assert.match(workflow, /RUNTIME_DEV=%s.+"\$runtime_ref"/u);
  assert.match(workflow, /RUNTIME_HML=%s.+"\$runtime_ref"/u);
  assert.doesNotMatch(workflow, /docker build(?:\s|$)|docker buildx build/u);
  assert.doesNotMatch(workflow, /:\s*latest\b|:latest\b/u);
});

test('documents single-owner governance for the public repository', async () => {
  const codeOwners = await text('.github/CODEOWNERS');
  const security = await text('.github/SECURITY.md');
  const dependabot = await text('.github/dependabot.yml');
  const contributing = await text('CONTRIBUTING.md');

  assert.match(codeOwners, /^\* @romulosutil$/mu);
  assert.match(codeOwners, /^\/\.github\/ @romulosutil$/mu);
  assert.match(security, /Security > Report a vulnerability/u);
  assert.match(security, /dados sint[eé]ticos/u);
  assert.match(dependabot, /package-ecosystem:\s*npm/u);
  assert.match(dependabot, /package-ecosystem:\s*github-actions/u);
  assert.match(dependabot, /package-ecosystem:\s*docker/u);
  assert.match(contributing, /@romulosutil.+único mantenedor/su);
  assert.match(contributing, /proíbe aprovar o próprio PR/u);
});

test('documents T00.2 as supply-chain enablement, not MSG behavior', async () => {
  const supplyChain = await text('docs/phase0/SUPPLY-CHAIN.md');

  assert.match(supplyChain, /T00\.2/u);
  assert.match(supplyChain, /MSG-02/u);
  assert.match(supplyChain, /MSG-03/u);
  assert.match(supplyChain, /enabler/u);
  assert.match(supplyChain, /n[aã]o satisfaz/u);
  assert.match(supplyChain, /Trivy/u);
  assert.match(supplyChain, /CI/u);
  assert.match(supplyChain, /runtime/u);
  assert.match(supplyChain, /dev.+hml|hml.+dev/su);
});
