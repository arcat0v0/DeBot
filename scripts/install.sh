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

install_systemd_user_service() {
  local env_file="$1" unit_dir unit_path user_name
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  unit_path="$unit_dir/$NAME.service"
  user_name="${USER:-${LOGNAME:-}}"

  mkdir -p "$unit_dir"
  cat >"$unit_path" <<EOF
[Unit]
Description=DeBot 多云运维 Telegram 机器人
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$WORKDIR
EnvironmentFile=-$env_file
ExecStart=$BINDIR/$NAME serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

  say "写入 systemd user unit：$unit_path"
  systemctl --user daemon-reload
  systemctl --user enable "$NAME.service"
  systemctl --user restart "$NAME.service"
  say "服务已重启：$NAME.service"

  if [ "${DEBOT_ENABLE_LINGER:-0}" = "1" ] && [ -n "$user_name" ]; then
    if loginctl enable-linger "$user_name" >/dev/null 2>&1; then
      say "已启用 linger：$user_name"
    else
      warn "无法启用 linger；服务仍会在当前用户会话内运行。需要开机自启时可手动执行：sudo loginctl enable-linger $user_name"
    fi
  fi
}

install_service() {
  local env_file="$1"
  if command -v systemctl >/dev/null 2>&1 &&
    systemctl --user show-environment >/dev/null 2>&1; then
    install_systemd_user_service "$env_file"
    return
  fi

  warn "未检测到可用的 systemd user，会回退到 debot 内置安装器。"
  "$BINDIR/$NAME" install --name "$NAME" --workdir "$WORKDIR" --env-file "$env_file" ||
    warn "服务安装返回非零，可手动执行：$BINDIR/$NAME install --workdir $WORKDIR --env-file $env_file"
  "$BINDIR/$NAME" restart --name "$NAME" ||
    warn "服务重启返回非零，可手动执行：$BINDIR/$NAME restart"
}

main() {
  local asset url env_file token users key host port old_version new_version cmd_name
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
  install_service "$env_file"

  cmd_name="$NAME"
  case ":$PATH:" in
    *":$BINDIR:"*) : ;;
    *) cmd_name="$BINDIR/$NAME" ;;
  esac

  echo
  say "完成！常用命令："
  echo "  $cmd_name status      # 查看状态"
  echo "  $cmd_name restart     # 重启"
  echo "  $cmd_name uninstall   # 卸载服务"
  echo
  say "现在去 Telegram 给你的机器人发送 /start 即可使用。"
}

main "$@"
