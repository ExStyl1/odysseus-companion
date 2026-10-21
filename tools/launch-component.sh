#!/bin/zsh
# Finder and a normal shell may have different PATHs. Use an existing Node 22+.
set -u
root="${0:A:h:h}"
node_candidates=(
  "${ODYSSEUS_NODE:-}"
  "$(command -v node 2>/dev/null)"
  /opt/homebrew/bin/node
  /usr/local/bin/node
  "$HOME"/.nvm/versions/node/*/bin/node(NOn)
)
for candidate in "${node_candidates[@]}"; do
  if [[ -x "$candidate" ]] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
    exec "$candidate" "$root/tools/run-component.mjs" "$@"
  fi
done
print -u2 'Для запуска Odysseus нужен установленный Node.js 22 или новее.'
exit 1
