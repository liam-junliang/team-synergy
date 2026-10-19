#!/bin/sh
set -eu
base_url=''
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/team-synergy/cli"
modify_path=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-url) base_url=$2; shift 2 ;;
    --install-dir) install_dir=$2; shift 2 ;;
    --no-modify-path) modify_path=0; shift ;;
    *) printf '%s\n' "Unknown option: $1" >&2; exit 1 ;;
  esac
done
case "$base_url" in
  https://*|http://localhost|http://localhost:*|http://localhost/*|http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*|http://\[::1\]|http://\[::1\]:*|http://\[::1\]/*) ;;
  *) echo 'Pass --base-url with an HTTPS API URL (HTTP is allowed only on localhost).' >&2; exit 1 ;;
esac
case "$base_url" in *'?'*|*'#'*|*'@'*|*' '*|*'"'*|*"'"*) echo 'Invalid API URL.' >&2; exit 1 ;; esac
base_url=${base_url%/}
case "$(uname -s)" in Linux) platform=linux ;; Darwin) platform=darwin ;; *) echo 'Use install.ps1 on Windows.' >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo 'Unsupported CPU architecture.' >&2; exit 1 ;; esac
case "$install_dir" in /*) ;; *) echo 'Install directory must be absolute.' >&2; exit 1 ;; esac
case "$install_dir" in /|*'/../'*|*'/./'*|*/..|*/.|*'
'*) echo 'Unsafe install directory.' >&2; exit 1 ;; esac
install_dir=${install_dir%/}
assert_no_links() {
  cursor=$1
  while [ "$cursor" != / ] && [ -n "$cursor" ]; do
    if [ -L "$cursor" ]; then echo "Installation path contains a link: $cursor" >&2; exit 1; fi
    cursor=$(dirname "$cursor")
  done
}
assert_no_links "$install_dir"
marker="$install_dir/.tsp-install"
if [ -e "$install_dir" ]; then
  assert_no_links "$marker"
  if [ ! -f "$marker" ] || [ "$(head -n 1 "$marker")" != team-synergy-cli ]; then echo 'Refusing to overwrite an unmanaged directory.' >&2; exit 1; fi
else
  mkdir -p "$install_dir"
  printf 'team-synergy-cli\n' > "$marker"
fi
lock="$install_dir/.install.lock"
if ! mkdir "$lock" 2>/dev/null; then echo 'Another install is running (or a previous install was interrupted).' >&2; exit 1; fi
stage=$(mktemp -d "$install_dir/.stage-XXXXXXXX")
cleanup() {
  case "$stage" in "$install_dir"/.stage-*) assert_no_links "$stage"; rm -rf -- "$stage" ;; *) echo 'Unsafe stage cleanup.' >&2; exit 1 ;; esac
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
curl -fLsS --proto '=http,https' --proto-redir '=https' "$base_url/cli/manifest.json?format=tsv" -o "$stage/manifest.tsv"
awk -F '\t' -v p="$platform" -v a="$arch" '$1 == p && $2 == a {print}' "$stage/manifest.tsv" > "$stage/target.tsv"
if [ "$(wc -l < "$stage/target.tsv" | tr -d ' ')" != 1 ]; then echo "This platform has not published a $platform $arch CLI. Contact its administrator." >&2; exit 1; fi
tab=$(printf '\t')
IFS="$tab" read -r _platform _arch filename expected size release < "$stage/target.tsv"
case "$filename" in *[!a-zA-Z0-9.-]*|'') echo 'Invalid release filename.' >&2; exit 1 ;; esac
case "$release" in *[!a-zA-Z0-9.-]*|'') echo 'Invalid release identity.' >&2; exit 1 ;; esac
case "$expected" in *[!a-f0-9]*|'') echo 'Invalid checksum.' >&2; exit 1 ;; esac
[ "${#expected}" = 64 ] || { echo 'Invalid checksum length.' >&2; exit 1; }
case "$size" in *[!0-9]*|'') echo 'Invalid release size.' >&2; exit 1 ;; esac
curl -fLsS --proto '=http,https' --proto-redir '=https' "$base_url/cli/releases/$filename" -o "$stage/release.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$stage/release.tar.gz" | cut -d ' ' -f 1); else actual=$(shasum -a 256 "$stage/release.tar.gz" | cut -d ' ' -f 1); fi
if [ "$actual" != "$expected" ] || [ "$(wc -c < "$stage/release.tar.gz" | tr -d ' ')" != "$size" ]; then echo 'CLI archive checksum mismatch. Installation was not changed.' >&2; exit 1; fi
tar -tzf "$stage/release.tar.gz" > "$stage/entries"
if grep -E '(^/|(^|/)\.\.(/|$))' "$stage/entries" >/dev/null; then echo 'Unsafe archive entry.' >&2; exit 1; fi
# Reject link entries before extraction, including hard links.
if tar -tvzf "$stage/release.tar.gz" | grep -E '^[lh]' >/dev/null; then echo 'Archive links are not supported.' >&2; exit 1; fi
mkdir "$stage/payload"
tar -xzf "$stage/release.tar.gz" -C "$stage/payload"
[ -f "$stage/payload/runtime/node" ] && [ -f "$stage/payload/apps/cli/dist/index.js" ] || { echo 'Incomplete CLI release.' >&2; exit 1; }
mkdir -p "$install_dir/versions" "$install_dir/bin"
assert_no_links "$install_dir/versions"; assert_no_links "$install_dir/bin"
installed_release="$release-$(basename "$stage" | cut -c 8-)"
mv "$stage/payload" "$install_dir/versions/$installed_release"
for command in tsp agentd; do
  printf '#!/bin/sh\nTSP_BIN=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$TSP_BIN/../versions/%s/%s" "$@"\n' "$installed_release" "$command" > "$stage/$command"
  chmod 755 "$stage/$command" "$install_dir/versions/$installed_release/$command" "$install_dir/versions/$installed_release/runtime/node"
  mv -f "$stage/$command" "$install_dir/bin/$command"
done
printf 'team-synergy-cli\n%s\n' "$installed_release" > "$marker"
if [ "$modify_path" = 1 ]; then
  # Quote the path as one shell literal; leave existing shell configuration intact.
  quoted=$(printf '%s' "$install_dir/bin" | sed "s/'/'\\\\''/g")
  line="export PATH='$quoted':\"\$PATH\""
  profile="$HOME/.profile"
  case "$(basename "${SHELL:-sh}")" in
    zsh) profile="$HOME/.zshrc" ;;
    bash) if [ "$(uname -s)" = Darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi ;;
  esac
  if ! grep -F "$line" "$profile" >/dev/null 2>&1; then printf '\n# Team Synergy CLI\n%s\n' "$line" >> "$profile"; fi
fi
printf 'Team Synergy CLI installed: %s/bin/tsp\nOpen a new terminal, then authorize this client: tsp auth login --api %s\n' "$install_dir" "$base_url"
