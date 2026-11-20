#!/bin/sh
# Run from the repository root after npm ci. Test the given tarball, not the checkout.
set -eu
root=$(pwd -P)
archive=${1:?Pass an npm pack .tgz}
tarball=$(cd "$(dirname "$archive")" && pwd -P)/$(basename "$archive")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/home" "$tmp/agent" "$tmp/consumer"
# No real profile, provider credentials, npm tokens or project .npmrc.
env -i PATH="$PATH" HOME="$tmp/home" PI_CODING_AGENT_DIR="$tmp/agent" \
  npm_config_registry=https://registry.npmjs.org/ sh -eu -s -- "$root" "$tarball" "$tmp/consumer" <<'SMOKE'
root=$1
cd "$3"
npm install --prefix . --ignore-scripts --legacy-peer-deps --no-audit --no-fund "$2"
pkg="$PWD/node_modules/pi-prompt-refine"
# Pi supplies peer packages; only non-host runtime dependencies should be installed above.
pi="$root/node_modules/.bin/pi"
"$pi" install "$pkg"
"$pi" list | grep -F 'pi-prompt-refine'
(cd "$root" && node --input-type=module - "$pkg" <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
const pkg = process.argv[2];
const { extensions, errors } = await discoverAndLoadExtensions([pkg], dirname(dirname(pkg)), process.env.PI_CODING_AGENT_DIR);
assert.deepEqual(errors, []);
assert.equal(extensions.length, 1);
assert.deepEqual([...extensions[0].commands.keys()].sort(), ['refine', 'refine-api']);
const catalog = JSON.parse(await readFile(`${pkg}/examples/prompt-refine-preferences.json`, 'utf8'));
assert.ok(catalog.entries.some(p => p.id === 'translate-prompt-to-english'));
JS
)
"$pi" remove "$pkg"
remaining=$("$pi" list)
if printf '%s\n' "$remaining" | grep -F 'pi-prompt-refine'; then exit 1; fi
SMOKE
