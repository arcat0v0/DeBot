#!/usr/bin/env bash
set -euo pipefail

REPO="arcat0v0/DeBot"
NAME="debot"
BINDIR="${DEBOT_BINDIR:-$HOME/.local/bin}"
WORKDIR="${DEBOT_HOME:-$HOME/.local/share/debot}"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

ask() {
  local prompt="$1" __var="$2" __val=""
  if [ -r /dev/tty ]; then
    read -rp "$prompt" __val < /dev/tty
  else
    read -rp "$prompt" __val
  fi
  printf -v "$__var" '%s' "$__val"
}

detect_asset() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  [ "$os" = "Linux" ] || die "目前只提供 Linux 版本（检测到 $os）。"
  case "$arch" in
    x86_64 | amd64) arch="x86_64" ;;
    aarch64 | arm64) arch="aarch64" ;;
    *) die "不支持的架构：$arch" ;;
  esac
  printf 'debot-linux-%s' "$arch"
}

download() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$out" "$url"
  else
    die "需要 curl 或 wget。"
  fi
}

main() {
  local asset url env_file token users key
  asset="$(detect_asset)"
  url="https://github.com/${REPO}/releases/latest/download/${asset}"

  if [ -f /etc/alpine-release ]; then
    warn "检测到 Alpine：二进制依赖 glibc，请先执行：apk add gcompat libstdc++"
  fi

  say "下载 ${asset} …"
  mkdir -p "$BINDIR" "$WORKDIR/data"
  download "$url" "$BINDIR/$NAME"
  chmod +x "$BINDIR/$NAME"
  say "已安装二进制：$BINDIR/$NAME"

  case ":$PATH:" in
    *":$BINDIR:"*) : ;;
    *)
      warn "$BINDIR 不在 PATH 中，请加入后重新登录，例如："
      warn "  echo 'export PATH=\"$BINDIR:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
      ;;
  esac

  "$BINDIR/$NAME" version >/dev/null 2>&1 ||
    die "二进制无法运行（若为 Alpine 请先安装 gcompat libstdc++）。"

  env_file="$WORKDIR/.env"
  if [ -f "$env_file" ]; then
    say "已存在配置 $env_file，跳过引导。"
  else
    say "配置 Telegram 机器人："
    echo "  1) 在 Telegram 找 @BotFather 创建机器人，获取 Bot Token"
    echo "  2) 找 @userinfobot 获取你的数字用户 ID"
    echo
    token="${TELEGRAM_BOT_TOKEN:-}"
    users="${DEBOT_ALLOWED_USERS:-}"
    [ -n "$token" ] || ask "Bot Token: " token
    [ -n "$users" ] || ask "允许使用的用户 ID（逗号分隔）: " users
    [ -n "$token" ] || die "Bot Token 不能为空。"
    key="$("$BINDIR/$NAME" genkey)"
    (
      umask 077
      cat >"$env_file" <<EOF
TELEGRAM_BOT_TOKEN=$token
DEBOT_ALLOWED_USERS=$users
DEBOT_MASTER_KEY=$key
DEBOT_DATA_DIR=$WORKDIR/data
DEBOT_LOG_LEVEL=info
EOF
    )
    say "已写入 $env_file（权限 600）"
  fi

  say "安装并启动服务 …"
  "$BINDIR/$NAME" install --name "$NAME" --workdir "$WORKDIR" --env-file "$env_file" --linger ||
    warn "服务安装返回非零，可手动执行：$BINDIR/$NAME install --workdir $WORKDIR --env-file $env_file"

  echo
  say "完成！常用命令："
  echo "  $NAME status      # 查看状态"
  echo "  $NAME restart     # 重启"
  echo "  $NAME uninstall   # 卸载服务"
  echo
  say "现在去 Telegram 给你的机器人发送 /start 即可使用。"
}

main "$@"
