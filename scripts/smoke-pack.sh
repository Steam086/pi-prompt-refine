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
env -i PATH="$PATH" HOME="$tmp/home" PI_CODING_AGENT_DIR="$tmp/agent" PI_TELEMETRY=0 \
  npm_config_registry=https://registry.npmjs.org/ sh -eu -s -- "$root" "$tarball" "$tmp/consumer" <<'SMOKE'
root=$1
cd "$3"
npm install --prefix . --ignore-scripts --legacy-peer-deps --no-audit --no-fund "$2"
consumer=$(pwd -P)
pkg="$consumer/node_modules/pi-prompt-refine"
# Pi supplies peer packages; only non-host runtime dependencies should be installed above.
pi="$root/node_modules/.bin/pi"
"$pi" install "$pkg"
"$pi" list | grep -F 'pi-prompt-refine'
(cd "$root" && PI_OFFLINE=1 node --input-type=module - "$pi" "$consumer" "$pkg" <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RpcClient } from '@earendil-works/pi-coding-agent';

const [cliPath, cwd, pkg] = process.argv.slice(2);
const catalog = JSON.parse(await readFile(`${pkg}/examples/prompt-refine-preferences.json`, 'utf8'));
assert.ok(catalog.entries.some(p => p.id === 'translate-prompt-to-english'));

const client = new RpcClient({ cliPath, cwd });
const notifications = [];
client.onEvent(event => {
  if (event.type === 'extension_ui_request' && event.method === 'notify') notifications.push(event.message);
});
try {
  await client.start();
  const commands = (await client.getCommands()).filter(command => command.sourceInfo?.path === `${pkg}/src/extension.ts`);
  assert.deepEqual(commands.map(command => command.name).sort(), ['refine', 'refine-api']);
  assert.equal(await client.prompt('/refine-api status'), 'handled');
  assert.ok(notifications.some(message => message.startsWith('Refine ok.')), 'Refine status did not report success');
  assert.deepEqual(await client.getMessages(), [], 'Status command added transcript messages');
} finally {
  await client.stop();
}
JS
)
"$pi" remove "$pkg"
remaining=$("$pi" list)
if printf '%s\n' "$remaining" | grep -F 'pi-prompt-refine'; then exit 1; fi
SMOKE
