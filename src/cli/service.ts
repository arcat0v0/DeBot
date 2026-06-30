import { dirname } from "@std/path";

export type InitSystem = "systemd" | "openrc";
export type Scope = "user" | "system";

export interface ExecSpec {
  bin: string;
  args: string[];
}

export interface ServiceOptions {
  name: string;
  description: string;
  workdir: string;
  envFile: string;
  exec: ExecSpec;
  user: string;
  group?: string;
}

export interface PlanParams {
  init: InitSystem;
  scope: Scope;
  home: string;
  linger: boolean;
  start: boolean;
}

export interface InstallFile {
  path: string;
  content: string;
  mode?: number;
}

export interface InstallPlan {
  init: InitSystem;
  scope: Scope;
  files: InstallFile[];
  commands: string[][];
}

export function systemdUnit(opts: ServiceOptions, scope: Scope): string {
  const wantedBy = scope === "system" ? "multi-user.target" : "default.target";
  const exec = `${opts.exec.bin} ${opts.exec.args.join(" ")}`.trim();
  const lines = [
    "[Unit]",
    `Description=${opts.description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${opts.workdir}`,
    `EnvironmentFile=-${opts.envFile}`,
  ];
  if (scope === "system") lines.push(`User=${opts.user}`);
  lines.push(
    `ExecStart=${exec}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    `WantedBy=${wantedBy}`,
    "",
  );
  return lines.join("\n");
}

export function openrcScript(opts: ServiceOptions): string {
  const userSpec = opts.group ? `${opts.user}:${opts.group}` : opts.user;
  const args = opts.exec.args.join(" ");
  return [
    "#!/sbin/openrc-run",
    `name="${opts.name}"`,
    `description="${opts.description}"`,
    `directory="${opts.workdir}"`,
    `command="${opts.exec.bin}"`,
    `command_args="${args}"`,
    `command_user="${userSpec}"`,
    `pidfile="/run/${opts.name}.pid"`,
    "command_background=true",
    "supervisor=supervise-daemon",
    `output_log="/var/log/${opts.name}.log"`,
    `error_log="/var/log/${opts.name}.log"`,
    "",
    "start_pre() {",
    `  if [ -f "${opts.envFile}" ]; then`,
    "    set -a",
    `    . "${opts.envFile}"`,
    "    set +a",
    "  fi",
    "}",
    "",
  ].join("\n");
}

export function resolveExec(
  mainModule: string,
  execPath: string,
  override?: string,
): ExecSpec {
  if (override) {
    const parts = override.split(/\s+/).filter((part) => part.length > 0);
    return { bin: parts[0], args: parts.slice(1) };
  }
  const base = execPath.split("/").pop() ?? execPath;
  if (base === "deno") {
    const scriptPath = mainModule.startsWith("file:")
      ? new URL(mainModule).pathname
      : mainModule;
    return {
      bin: execPath,
      args: [
        "run",
        "--allow-net",
        "--allow-env",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        scriptPath,
        "serve",
      ],
    };
  }
  return { bin: execPath, args: ["serve"] };
}

export function buildPlan(
  opts: ServiceOptions,
  params: PlanParams,
): InstallPlan {
  if (params.init === "systemd") {
    const unitPath = params.scope === "system"
      ? `/etc/systemd/system/${opts.name}.service`
      : `${params.home}/.config/systemd/user/${opts.name}.service`;
    const ctl = params.scope === "system"
      ? ["systemctl"]
      : ["systemctl", "--user"];
    const commands: string[][] = [[...ctl, "daemon-reload"]];
    if (params.linger && params.scope === "user") {
      commands.push(["loginctl", "enable-linger", opts.user]);
    }
    commands.push([...ctl, "enable", `${opts.name}.service`]);
    if (params.start) {
      commands.push([...ctl, "restart", `${opts.name}.service`]);
    }
    return {
      init: "systemd",
      scope: params.scope,
      files: [{ path: unitPath, content: systemdUnit(opts, params.scope) }],
      commands,
    };
  }

  const scriptPath = `/etc/init.d/${opts.name}`;
  const commands: string[][] = [["rc-update", "add", opts.name, "default"]];
  if (params.start) commands.push(["rc-service", opts.name, "start"]);
  return {
    init: "openrc",
    scope: "system",
    files: [{ path: scriptPath, content: openrcScript(opts), mode: 0o755 }],
    commands,
  };
}

export function planToString(plan: InstallPlan): string {
  const sections: string[] = [];
  for (const file of plan.files) {
    sections.push(`# ${file.path}\n${file.content}`);
  }
  sections.push(
    "# 将执行的命令：\n" +
      plan.commands.map((cmd) => "  " + cmd.join(" ")).join("\n"),
  );
  return sections.join("\n");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectInit(): Promise<InitSystem | undefined> {
  if (await pathExists("/run/systemd/system")) return "systemd";
  if (
    (await pathExists("/sbin/openrc-run")) ||
    (await pathExists("/sbin/rc-service")) ||
    (await pathExists("/etc/alpine-release"))
  ) {
    return "openrc";
  }
  return undefined;
}

export interface RunResult {
  ok: boolean;
  out: string;
  err: string;
}

export async function runCommand(
  cmd: string,
  args: string[],
): Promise<RunResult> {
  try {
    const output = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      ok: output.success,
      out: new TextDecoder().decode(output.stdout).trim(),
      err: new TextDecoder().decode(output.stderr).trim(),
    };
  } catch (error) {
    return { ok: false, out: "", err: String(error) };
  }
}

export async function applyPlan(
  plan: InstallPlan,
  log: (message: string) => void,
): Promise<void> {
  for (const file of plan.files) {
    await Deno.mkdir(dirname(file.path), { recursive: true });
    await Deno.writeTextFile(file.path, file.content);
    if (file.mode !== undefined) {
      try {
        await Deno.chmod(file.path, file.mode);
      } catch {
        void 0;
      }
    }
    log(`写入 ${file.path}`);
  }
  for (const cmd of plan.commands) {
    const result = await runCommand(cmd[0], cmd.slice(1));
    if (result.ok) {
      log(`执行 ${cmd.join(" ")}`);
    } else {
      log(`命令失败 ${cmd.join(" ")}：${result.err || result.out}`);
    }
  }
}
