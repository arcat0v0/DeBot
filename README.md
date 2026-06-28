# DeBot

DeBot is a self-hosted, Telegram-driven multi-cloud operations bot built with
Deno and TypeScript. It reproduces the useful instance-lifecycle controls of
R-Bot without paid gating and without the heavier web-panel / Web SSH surfaces.

You add cloud credentials through a private Telegram chat, then list and control
instances across **AWS (EC2 + Lightsail)**, **Azure**, **Google Cloud** and
**DigitalOcean** from inline keyboards.

## One-line install (Linux)

Downloads the latest release binary into `~/.local/bin`, installs the service
(systemd user / OpenRC), and walks you through the Telegram setup:

```sh
curl -fsSL https://raw.githubusercontent.com/arcat0v0/DeBot/main/scripts/install.sh | bash
```

On Alpine (musl) install `apk add gcompat libstdc++` first. See
[Single binary](#single-binary-deno-compile) to build from source instead.

## Features

- Telegram bot with inline-keyboard menus and confirmation prompts.
- Provider-neutral instance lifecycle: list, detail, start, stop, reboot,
  delete, rename (where supported) and create-from-preset.
- Four providers via direct REST APIs (no heavyweight SDKs):
  - **AWS EC2** — SigV4-signed Query API.
  - **AWS Lightsail** — SigV4-signed JSON API.
  - **Azure** — virtual machines over the ARM REST API.
  - **Google Cloud** — Compute Engine over REST with service-account JWT auth.
  - **DigitalOcean** — droplets over the v2 REST API.
- Local, encrypted credential storage (AES-256-GCM via Web Crypto).
- Telegram allowlist so only your user IDs can drive the bot.
- A local job queue for long-running create/delete operations.
- Long-polling or webhook runtime modes plus `/healthz` and `/readyz`.

### Out of scope (by design)

Telegram monitoring / auto-remediation, a web management panel, Web SSH, Oracle
Cloud / SolusVM / VirtFusion, cloud-host sync, and Cloudflare. These are
intentionally excluded; see [docs/PLAN.md](docs/PLAN.md).

## Quick start

1. Install [Deno](https://deno.com) 2.x.
2. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
3. Find your numeric Telegram user id with
   [@userinfobot](https://t.me/userinfobot).
4. Configure the environment:

   ```sh
   cp .env.example .env
   # edit .env: set TELEGRAM_BOT_TOKEN and DEBOT_ALLOWED_USERS
   ```

5. Run it:

   ```sh
   deno task start
   ```

6. Open your bot in Telegram and send `/start`. Add a cloud profile with
   `/profile`, then drive instances from the menus.

## Commands

| Command                      | Description                             |
| ---------------------------- | --------------------------------------- |
| `/start`                     | Open the main cloud menu                |
| `/aws` `/azure` `/gcp` `/do` | Open a provider directly                |
| `/profile`                   | Add, switch or remove cloud credentials |
| `/presets`                   | Manage reusable creation presets        |
| `/jobs`                      | Show recent async operations            |
| `/help`                      | Show help                               |

## Configuration

All configuration is environment-based; see [.env.example](.env.example) for the
full list. The most important variables:

- `TELEGRAM_BOT_TOKEN` — bot token (required).
- `DEBOT_ALLOWED_USERS` — comma/space separated Telegram user ids.
- `DEBOT_DATA_DIR` — where encrypted state lives (default `./data`).
- `DEBOT_MASTER_KEY` — optional base64 AES key; auto-generated if absent.
- `DEBOT_MODE` — `polling` (default) or `webhook` (needs `DEBOT_PUBLIC_URL`).

## Credentials and IAM

Per-provider credential formats and the least-privilege permissions DeBot needs
are documented in [docs/PERMISSIONS.md](docs/PERMISSIONS.md). Secrets are
encrypted at rest and never written to logs.

## Development

```sh
deno task check   # type-check the app graph
deno task test    # run the test suite
deno task lint    # lint
deno task fmt     # format
deno task dev     # run with --watch
```

The test suite includes the AWS SigV4 published test vector, a cryptographic
round-trip of the GCP service-account JWT, the XML parser, encrypted storage,
the job queue, and end-to-end bot flows against a mock provider.

## Single binary (`deno compile`)

Package DeBot into one self-contained executable with Deno's native compiler:

```sh
deno task compile        # produces dist/debot
./dist/debot version
./dist/debot serve       # run the bot (same as deno task start)
```

The binary is the bot **and** its own installer (see below). Note:
`deno compile` targets glibc Linux. On **Alpine (musl)** install the compat
shims first (`apk add gcompat libstdc++`), or just run from source with `deno`.

## Install as a service (CLI)

The `debot` CLI installs itself as a service that runs **as the current user**.
It auto-detects systemd (user-level) or OpenRC (Alpine):

```sh
# from the compiled binary
./dist/debot install                 # systemd --user, starts now
./dist/debot install --linger        # also survive logout / start at boot
./dist/debot install --print         # dry-run: show the unit + commands only
./dist/debot status
./dist/debot uninstall

# or straight from source
deno task cli install --print
```

Useful flags: `--name`, `--workdir`, `--env-file`, `--exec`, `--system` (root,
system-level systemd), `--init systemd|openrc`, `--skip-start`. Run `debot help`
for the full list. On Alpine/OpenRC the init script writes to `/etc/init.d` and
needs root (`sudo ./dist/debot install`); it still runs the daemon as the chosen
`--user`.

Generate the encryption master key once and put it in `.env`:

```sh
echo "DEBOT_MASTER_KEY=$(./dist/debot genkey)" >> .env
```

## Deployment (other)

- **Docker:**
  `docker build -t debot . && docker run --env-file .env -p 8080:8080 -v $PWD/data:/app/data debot`
- **systemd (static unit):** see [deploy/debot.service](deploy/debot.service).

## Architecture

```
src/
  main.ts            entry point and wiring
  app/               config, logger, HTTP server
  bot/               Telegram client, dispatcher, menus, sessions
  cloud/             provider-neutral types, registry, service
    providers/       aws (ec2/lightsail/sigv4), azure, gcp, digitalocean, mock
  jobs/              async job queue and store
  storage/           encrypted profiles, presets, json helpers
  security/          AES-GCM crypto and master key handling
  shared/            errors and small utilities
```

Bot handlers only call the provider-neutral `ProviderAdapter` interface; each
adapter translates DeBot operations into provider REST calls.
