# DeBot — 维护说明（给 Claude）

DeBot 是用 Deno + TypeScript 写的自托管多云运维 Telegram 机器人（AWS
EC2/Lightsail、
Azure、GCP、DigitalOcean）。机器人界面为中文。仓库：`arcat0v0/DeBot`（MIT，公开）。

## 约定

- **提交信息用 gitmoji**（开头一个 emoji），例如
  `🎉 initial commit`、`🔖 release v0.2.0`、
  `🐛 fix ...`、`✨ ...`、`📝 ...`、`♻️ ...`。
- **提交不要写 `Co-Authored-By`。**
- **不写代码注释**（保持现有风格）。
- 绝不提交密钥/状态：`.env`、`data/`、`dist/` 已在 `.gitignore` 中。
- 改动后请保证：`deno task check`、`deno lint`、`deno fmt --check`、
  `deno test --allow-net --allow-env --allow-read --allow-write` 全绿。

## 常用命令

```sh
deno task start     # 运行机器人 + 健康检查
deno task dev       # --watch 运行
deno task check     # 类型检查（src/main.ts src/cli.ts）
deno task test      # 测试
deno task lint      # lint
deno task fmt       # 格式化
deno task cli ...   # CLI（serve/install/uninstall/status/genkey…）
deno task compile   # 打包单文件二进制到 dist/debot
```

## 发布（一键）

打 tag、跑门禁、改版本号、编译两种架构、创建 GitHub Release，全部由
`scripts/release.sh` 完成：

```sh
./scripts/release.sh v0.2.0            # 完整发布
./scripts/release.sh v0.2.0 --skip-checks   # 跳过 check/lint/fmt/test
```

脚本做的事：校验 `vX.Y.Z` 与干净工作区 → 跑质量门禁 → 把 `src/cli.ts` 里的
`VERSION` 改成该版本并以 `🔖 release vX.Y.Z` 提交并推送 → `deno compile` 出
`debot-linux-x86_64` 与 `debot-linux-aarch64` → `gh release create` 上传二进制。
安装脚本 `scripts/install.sh` 始终从 `releases/latest/download/<asset>` 拉取。

脚本内容（`scripts/release.sh`）：

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
SKIP_CHECKS=0
for arg in "$@"; do
  [ "$arg" = "--skip-checks" ] && SKIP_CHECKS=1
done

if [ -z "$VERSION" ] || [ "$VERSION" = "--skip-checks" ]; then
  echo "用法: scripts/release.sh vX.Y.Z [--skip-checks]"; exit 1
fi
if ! [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "版本号需形如 v1.2.3（当前: $VERSION）"; exit 1
fi
NUM="${VERSION#v}"

command -v deno >/dev/null 2>&1 || { echo "需要 deno"; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "需要 gh"; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交改动，请先提交后再发布。"; exit 1
fi

if [ "$SKIP_CHECKS" -eq 0 ]; then
  deno task check
  deno lint
  deno fmt --check
  deno test --allow-net --allow-env --allow-read --allow-write
fi

sed -i.bak -E "s/const VERSION = \"[0-9]+\.[0-9]+\.[0-9]+\";/const VERSION = \"$NUM\";/" src/cli.ts
rm -f src/cli.ts.bak
deno fmt src/cli.ts >/dev/null

if [ -n "$(git status --porcelain src/cli.ts)" ]; then
  git add src/cli.ts
  git commit -m "🔖 release $VERSION"
fi
git push origin HEAD

mkdir -p dist
rm -f dist/debot-linux-x86_64 dist/debot-linux-aarch64
flags=(--allow-net --allow-env --allow-read --allow-write --allow-run)
deno compile "${flags[@]}" --target x86_64-unknown-linux-gnu  --output dist/debot-linux-x86_64  src/cli.ts
deno compile "${flags[@]}" --target aarch64-unknown-linux-gnu --output dist/debot-linux-aarch64 src/cli.ts

gh release create "$VERSION" \
  dist/debot-linux-x86_64 dist/debot-linux-aarch64 \
  --title "$VERSION" --notes "..."
```
