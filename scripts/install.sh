#!/usr/bin/env bash
set -euo pipefail

REPO="arcat0v0/DeBot"
NAME="debot"
BINDIR="${DEBOT_BINDIR:-$HOME/.local/bin}"
WORKDIR="${DEBOT_HOME:-$HOME/.config/debot}"
TMP_DOWNLOAD=""

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }
cleanup() {
  [ -z "$TMP_DOWNLOAD" ] || rm -f "$TMP_DOWNLOAD"
}
trap cleanup EXIT

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
  local asset url env_file token users key host port old_version new_version
  asset="$(detect_asset)"
  url="https://github.com/${REPO}/releases/latest/download/${asset}"

  if [ -f /etc/alpine-release ]; then
    warn "检测到 Alpine：二进制依赖 glibc，请先执行：apk add gcompat libstdc++"
  fi

  say "下载 ${asset} …"
  mkdir -p "$BINDIR" "$WORKDIR/data"
  if [ -x "$BINDIR/$NAME" ]; then
    old_version="$("$BINDIR/$NAME" version 2>/dev/null || true)"
  else
    old_version=""
  fi
  TMP_DOWNLOAD="$(mktemp "$BINDIR/.${NAME}.download.XXXXXX")"
  download "$url" "$TMP_DOWNLOAD"
  chmod 0755 "$TMP_DOWNLOAD"
  new_version="$("$TMP_DOWNLOAD" version 2>/dev/null || true)"
  [ -n "$new_version" ] ||
    die "下载的二进制无法运行（若为 Alpine 请先安装 gcompat libstdc++）。"
  mv -f "$TMP_DOWNLOAD" "$BINDIR/$NAME"
  TMP_DOWNLOAD=""
  say "已安装二进制：$BINDIR/$NAME"
  if [ -n "$old_version" ] && [ "$old_version" != "$new_version" ]; then
    say "版本更新：$old_version -> $new_version"
  else
    say "当前版本：$new_version"
  fi

  case ":$PATH:" in
    *":$BINDIR:"*) : ;;
    *)
      warn "$BINDIR 不在 PATH 中，请加入后重新登录，例如："
      warn "  echo 'export PATH=\"$BINDIR:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
      ;;
  esac

  env_file="$WORKDIR/config.env"
  if [ -f "$env_file" ]; then
    say "已存在配置 $env_file，跳过引导。"
  else
    say "配置 Telegram 机器人："
    echo "  1) 在 Telegram 找 @BotFather 创建机器人，复制它给的 Bot Token"
    echo "  2) 准备你的数字用户 ID（白名单，决定谁能使用机器人）："
    echo "       方法A：给 @userinfobot 发任意消息，它会回复形如 123456789 的 ID"
    echo "       方法B：此项留空，安装后给你的机器人发 /start，"
    echo "              机器人会回复你的用户 ID，再填入并执行 $NAME restart"
    echo
    token="${TELEGRAM_BOT_TOKEN:-}"
    users="${DEBOT_ALLOWED_USERS:-}"
    host="${DEBOT_HOST:-0.0.0.0}"
    port="${DEBOT_PORT:-18080}"
    [ -n "$token" ] || ask "Bot Token: " token
    [ -n "$users" ] || ask "允许使用的用户 ID（逗号分隔，可留空）: " users
    [ -n "$token" ] || die "Bot Token 不能为空。"
    key="$("$BINDIR/$NAME" genkey)"
    (
      umask 077
      cat >"$env_file" <<EOF
TELEGRAM_BOT_TOKEN=$token
DEBOT_ALLOWED_USERS=$users
DEBOT_MASTER_KEY=$key
DEBOT_DATA_DIR=$WORKDIR/data
DEBOT_HOST=$host
DEBOT_PORT=$port
DEBOT_LOG_LEVEL=info
EOF
    )
    say "已写入 $env_file（权限 600）"
    [ -n "$users" ] ||
      warn "用户 ID 留空：稍后给机器人发 /start，它会回复你的 ID；填入 $env_file 的 DEBOT_ALLOWED_USERS 后执行 $NAME restart。"
  fi

  say "安装并启动服务 …"
  "$BINDIR/$NAME" install --name "$NAME" --workdir "$WORKDIR" --env-file "$env_file" --linger ||
    warn "服务安装返回非零，可手动执行：$BINDIR/$NAME install --workdir $WORKDIR --env-file $env_file"
  say "重启服务以应用当前版本 …"
  "$BINDIR/$NAME" restart --name "$NAME" ||
    warn "服务重启返回非零，可手动执行：$BINDIR/$NAME restart"

  echo
  say "完成！常用命令："
  echo "  $NAME status      # 查看状态"
  echo "  $NAME restart     # 重启"
  echo "  $NAME uninstall   # 卸载服务"
  echo
  say "现在去 Telegram 给你的机器人发送 /start 即可使用。"
}

main "$@"
