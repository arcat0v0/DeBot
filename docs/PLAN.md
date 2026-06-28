# DeBot Project Plan

## 1. Project Goal

DeBot is a self-hosted Telegram-driven multi-cloud operations bot built with
Deno and TypeScript. It aims to provide the useful cloud lifecycle controls from
R-Bot without paid gating and without the heavier web-panel and Web SSH
surfaces.

The first product shape is:

- A Telegram bot for on-demand cloud operations.
- Local credential storage controlled by the operator.
- Provider adapters for AWS, Azure, GCP, and DigitalOcean.
- Basic instance lifecycle workflows: list, detail, create, start, stop, reboot,
  delete, and IP-related operations where each cloud supports them.
- A small local HTTP service for health checks and Telegram webhook mode.

## 2. Explicit Non-Goals

These are intentionally out of scope for the initial project:

- Telegram bot monitoring and auto-remediation.
- Web cloud management panel.
- Web SSH terminal.
- Oracle Cloud integration.
- SolusVM integration.
- VirtFusion integration.
- Cloud host sync into an SSH session list.
- Cloudflare integration for now.

If any of these are added later, they should be designed as optional modules and
kept off by default.

## 3. Initial Feature Scope

### Telegram Bot

- `/start`: show main cloud menu.
- `/help`: show available commands and required setup.
- `/profile`: list, switch, add, update, and delete cloud credentials.
- `/aws`: open AWS operation menu.
- `/azure`: open Azure operation menu.
- `/gcp`: open GCP operation menu.
- `/do`: open DigitalOcean operation menu.
- `/jobs`: show recent async operation status.

Menus should use Telegram inline keyboards for repeatable operations and
confirmation prompts for destructive actions.

### Cloud Lifecycle Operations

Common operations:

- List instances.
- Show instance detail.
- Create instance from a saved preset.
- Start instance.
- Stop instance.
- Reboot instance.
- Delete instance after confirmation.
- Rename instance when the provider supports it.

Provider-specific first pass:

- AWS EC2: list, detail, start, stop, reboot, terminate, create from preset.
- AWS Lightsail: list, detail, start, stop, reboot, delete, basic static IP
  operations.
- Azure VM: list, detail, start, stop/deallocate, restart, delete, create from
  preset.
- GCP Compute Engine: list, detail, start, stop, reset, delete, create from
  preset.
- DigitalOcean Droplet: list, detail, create, power on/off, reboot, delete,
  reserved IP where practical.

### Presets

Presets should make creation repeatable without forcing the user through long
forms every time:

- Provider.
- Region / zone.
- Image.
- Instance size.
- SSH public key id or raw key reference.
- Network/security defaults.
- Tags / labels.

## 4. Architecture

Recommended layout:

```text
src/
  main.ts
  app/
    server.ts
    config.ts
    logger.ts
  bot/
    telegram.ts
    commands/
    keyboards/
    sessions.ts
  cloud/
    types.ts
    registry.ts
    providers/
      aws/
      azure/
      gcp/
      digitalocean/
  jobs/
    queue.ts
    store.ts
  storage/
    profiles.ts
    presets.ts
    secrets.ts
  security/
    crypto.ts
  shared/
    errors.ts
    result.ts
```

Core design:

- `cloud/types.ts` defines one provider-neutral interface.
- Each provider adapter translates DeBot operations into provider SDK or REST
  calls.
- Bot commands only call provider-neutral services, not provider SDKs directly.
- Long-running create/delete operations run through a local job queue.
- Destructive operations require an explicit confirmation token.

## 5. Runtime Model

Supported Telegram modes:

- Long polling for simple self-hosting.
- Webhook mode when `DEBOT_PUBLIC_URL` is configured.

Local HTTP endpoints:

- `GET /healthz`: process health.
- `GET /readyz`: configuration readiness.
- `POST /telegram/webhook`: Telegram webhook receiver.

No browser management UI should be added in the first version.

## 6. Storage and Secrets

MVP storage can use local JSON files under a configurable data directory:

```text
data/
  profiles.json
  presets.json
  jobs.jsonl
```

Secrets should not be stored as plain text. Initial implementation should use:

- A local master key supplied by environment variable or generated into a local
  file with restrictive permissions.
- AES-GCM encryption via Web Crypto.
- Clear separation between profile metadata and encrypted secret payloads.

Future migration path:

- SQLite for richer query and audit logs.
- External secret stores as optional integrations.

## 7. Provider Implementation Notes

AWS:

- Use npm imports for AWS SDK v3 if Deno compatibility is acceptable.
- Keep EC2 and Lightsail as separate internal clients.

Azure:

- Use Azure SDK npm packages where compatible.
- Start with service principal credentials: tenant id, client id, client secret,
  subscription id.

GCP:

- Use service account JSON credentials.
- Prefer direct REST calls if the Node SDK path becomes too heavy in Deno.

DigitalOcean:

- Use REST API through `fetch`.
- Keep token handling simple and encrypted.

## 8. Security Rules

- Never log access keys, service account JSON, client secrets, or Telegram
  tokens.
- Destructive operations require confirmation.
- Limit bot access with an allowlist of Telegram user IDs.
- Keep all cloud credentials local to the DeBot host.
- Prefer least-privilege cloud IAM roles and document required permissions per
  provider.

## 9. Milestones

### M0: Skeleton

- Deno project initialized.
- Project plan committed.
- Basic health endpoint and test kept passing.

### M1: Bot Foundation

- Telegram long polling.
- User allowlist.
- Command router.
- Inline keyboard helpers.
- Basic local profile storage with encrypted secrets.

### M2: Provider Abstraction

- Common cloud types.
- Provider registry.
- Mock provider for tests.
- Job queue and confirmation workflow.

### M3: AWS

- AWS profile setup.
- EC2 list/detail/start/stop/reboot/terminate.
- Lightsail list/detail/start/stop/reboot/delete.
- Create-from-preset for EC2.

### M4: GCP and Azure

- GCP Compute Engine lifecycle operations.
- Azure VM lifecycle operations.
- Create-from-preset for both.

### M5: DigitalOcean

- Droplet lifecycle operations.
- Create-from-preset.
- Reserved IP basics if API behavior is straightforward.

### M6: Hardening

- Permission documentation.
- Error normalization.
- Audit log.
- Rate limiting for Telegram callbacks.
- Packaging with Docker and systemd examples.

## 10. Open Decisions

- Whether to support webhook mode in the MVP or start with polling only.
- Whether data storage stays JSON for v1 or moves to SQLite before real use.
- Whether DigitalOcean is required in the first public release or kept as phase
  two.
- Whether instance creation should be fully interactive or preset-only for v1.
