#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-}"
SKIP_CHECKS=0
for arg in "$@"; do
  [ "$arg" = "--skip-checks" ] && SKIP_CHECKS=1
done

if [ -z "$VERSION" ] || [ "$VERSION" = "--skip-checks" ]; then
  echo "用法: scripts/release.sh vX.Y.Z [--skip-checks]"
  exit 1
fi
if ! [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "版本号需形如 v1.2.3（当前: $VERSION）"
  exit 1
fi
NUM="${VERSION#v}"

command -v deno >/dev/null 2>&1 || { echo "需要 deno"; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "需要 gh"; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交改动，请先提交后再发布。"
  exit 1
fi

if [ "$SKIP_CHECKS" -eq 0 ]; then
  echo "==> 质量门禁（check / lint / fmt / test）"
  deno task check
  deno lint
  deno fmt --check
  deno test --allow-net --allow-env --allow-read --allow-write
fi

echo "==> 写入版本号 $NUM 到 src/cli.ts"
sed -i.bak -E "s/const VERSION = \"[0-9]+\.[0-9]+\.[0-9]+\";/const VERSION = \"$NUM\";/" src/cli.ts
rm -f src/cli.ts.bak
deno fmt src/cli.ts >/dev/null

if [ -n "$(git status --porcelain src/cli.ts)" ]; then
  git add src/cli.ts
  git commit -m "🔖 release $VERSION"
fi
git push origin HEAD

echo "==> 编译二进制（x86_64 + aarch64）"
mkdir -p dist
rm -f dist/debot-linux-x86_64 dist/debot-linux-aarch64
flags=(--allow-net --allow-env --allow-read --allow-write --allow-run)
deno compile "${flags[@]}" --target x86_64-unknown-linux-gnu \
  --output dist/debot-linux-x86_64 src/cli.ts
deno compile "${flags[@]}" --target aarch64-unknown-linux-gnu \
  --output dist/debot-linux-aarch64 src/cli.ts

echo "==> 创建 GitHub Release $VERSION"
notes="$(cat <<EOF
DeBot $VERSION — 自托管多云运维 Telegram 机器人（AWS / Azure / GCP / DigitalOcean）。

## 一键安装（Linux）
\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/arcat0v0/DeBot/main/scripts/install.sh | bash
\`\`\`

资源：\`debot-linux-x86_64\` / \`debot-linux-aarch64\`（glibc）。
Alpine（musl）需先 \`apk add gcompat libstdc++\`。
EOF
)"
gh release create "$VERSION" \
  dist/debot-linux-x86_64 dist/debot-linux-aarch64 \
  --title "$VERSION" --notes "$notes"

echo "==> 完成：$(gh release view "$VERSION" --json url -q .url)"
