// Docker Desktop cannot resolve Windows workspace junctions. Resolve only this
// repository's existing workspace packages; third-party modules use Node normally.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@crm-silmer/'))
      return nextResolve(specifier, context);
    const [name, ...subpath] = specifier
      .slice('@crm-silmer/'.length)
      .split('/');
    if (
      !/^[a-z0-9-]+$/u.test(name) ||
      subpath.some((part) => !/^[a-z0-9-]+$/u.test(part))
    )
      return nextResolve(specifier, context);
    const directory = new URL(`../modules/${name}/`, import.meta.url);
    const manifest = JSON.parse(
      readFileSync(new URL('package.json', directory), 'utf8'),
    );
    const entry = subpath.length
      ? manifest.exports?.['./' + subpath.join('/')]
      : (manifest.exports?.['.'] ?? manifest.exports ?? manifest.main);
    if (typeof entry !== 'string') throw new Error('WORKSPACE_EXPORT_INVALID');
    return nextResolve(new URL(entry, directory).href, context);
  },
});
