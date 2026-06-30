import { parseArgs } from "@std/cli/parse-args";
import { runServer } from "./main.ts";
import { generateMasterKeyBase64 } from "./security/crypto.ts";
import {
  applyPlan,
  buildPlan,
  detectInit,
  type InitSystem,
  planToString,
  resolveExec,
  runCommand,
  type Scope,
  type ServiceOptions,
} from "./cli/service.ts";

const VERSION = "0.2.4";

const HELP = `DeBot ${VERSION} — 自托管多云运维机器人

用法：
  debot serve                启动机器人与健康检查服务（默认）
  debot install [选项]       安装为系统服务并启动（systemd 用户级 / OpenRC）
  debot uninstall            停止并移除服务
  debot start|stop|restart   控制已安装的服务
  debot status               查看服务状态
  debot genkey               生成一个 AES-256 主密钥（base64）
  debot version              显示版本
  debot help                 显示本帮助

install 选项：
  --name <名称>      服务名（默认 debot）
  --system           安装为系统级 systemd 服务（需 root，以 --user 指定的用户运行）
  --user <用户名>    服务运行的用户（默认当前用户）
  --group <组名>     OpenRC 下的运行用户组
  --workdir <目录>   工作目录（默认当前目录）
  --env-file <路径>  环境变量文件（默认 <工作目录>/.env）
  --exec <命令>      自定义启动命令（默认自动推断）
  --init systemd|openrc   手动指定 init 系统（默认自动检测）
  --linger           systemd 用户级：开启 lingering 以便开机自启
  --skip-start       仅安装与开机自启，不立即启动
  --print            只打印将生成的服务文件与命令，不实际执行

打包为单个二进制：
  deno task compile          生成 dist/debot（使用 deno compile）
`;

interface CliArgs {
  _: (string | number)[];
  name?: string;
  user?: string;
  group?: string;
  workdir?: string;
  "env-file"?: string;
  exec?: string;
  init?: string;
  system?: boolean;
  linger?: boolean;
  "skip-start"?: boolean;
  print?: boolean;
  help?: boolean;
}

function parse(): CliArgs {
  return parseArgs(Deno.args, {
    boolean: ["system", "linger", "skip-start", "print", "help"],
    string: ["name", "user", "group", "workdir", "env-file", "exec", "init"],
    alias: { h: "help" },
  }) as CliArgs;
}

function currentUser(): string {
  return Deno.env.get("USER") ?? Deno.env.get("LOGNAME") ?? "root";
}

function homeDir(user: string): string {
  return Deno.env.get("HOME") ?? `/home/${user}`;
}

async function resolveInit(args: CliArgs): Promise<InitSystem> {
  if (args.init === "systemd" || args.init === "openrc") return args.init;
  const detected = await detectInit();
  if (!detected) {
    console.error("无法检测 init 系统，请用 --init systemd|openrc 指定。");
    Deno.exit(1);
  }
  return detected;
}

async function cmdInstall(args: CliArgs): Promise<void> {
  const name = args.name ?? "debot";
  const workdir = args.workdir ?? Deno.cwd();
  const user = args.user ?? currentUser();
  const init = await resolveInit(args);
  const scope: Scope = init === "openrc"
    ? "system"
    : args.system
    ? "system"
    : "user";
  const opts: ServiceOptions = {
    name,
    description: "DeBot 多云运维 Telegram 机器人",
    workdir,
    envFile: args["env-file"] ?? `${workdir}/.env`,
    exec: resolveExec(Deno.mainModule, Deno.execPath(), args.exec),
    user,
    group: args.group,
  };
  const plan = buildPlan(opts, {
    init,
    scope,
    home: homeDir(user),
    linger: Boolean(args.linger),
    start: !args["skip-start"],
  });

  if (args.print) {
    console.log(planToString(plan));
    return;
  }

  console.log(`安装 ${name}（${init}，${scope}）…`);
  try {
    await applyPlan(plan, (message) => console.log("  " + message));
  } catch (error) {
    if (
      error instanceof Deno.errors.PermissionDenied ||
      /denied/i.test(String(error))
    ) {
      console.error(
        `\n写入服务文件被拒绝。${
          init === "openrc" || scope === "system"
            ? "请用 root 运行，例如：sudo "
            : ""
        }` +
          "或加 --print 先查看内容。",
      );
      Deno.exit(1);
    }
    throw error;
  }
  console.log("\n完成。");
  if (init === "systemd" && scope === "user") {
    console.log(`查看状态：systemctl --user status ${name}`);
    console.log(`查看日志：journalctl --user -u ${name} -f`);
  } else if (init === "systemd") {
    console.log(`查看状态：systemctl status ${name}`);
  } else {
    console.log(`查看状态：rc-service ${name} status`);
  }
}

function serviceController(
  init: InitSystem,
  scope: Scope,
  name: string,
  action: string,
): string[] {
  if (init === "systemd") {
    return scope === "system"
      ? ["systemctl", action, name]
      : ["systemctl", "--user", action, name];
  }
  return ["rc-service", name, action];
}

async function cmdServiceCtl(action: string, args: CliArgs): Promise<void> {
  const name = args.name ?? "debot";
  const init = await resolveInit(args);
  const scope: Scope = init === "openrc"
    ? "system"
    : args.system
    ? "system"
    : "user";
  const cmd = serviceController(init, scope, name, action);
  const result = await runCommand(cmd[0], cmd.slice(1));
  if (result.out) console.log(result.out);
  if (result.err) console.error(result.err);
  if (!result.ok) Deno.exit(1);
}

async function cmdUninstall(args: CliArgs): Promise<void> {
  const name = args.name ?? "debot";
  const init = await resolveInit(args);
  const scope: Scope = init === "openrc"
    ? "system"
    : args.system
    ? "system"
    : "user";
  const home = homeDir(args.user ?? currentUser());
  if (init === "systemd") {
    const ctl = scope === "system" ? ["systemctl"] : ["systemctl", "--user"];
    await runCommand(ctl[0], [
      ...ctl.slice(1),
      "disable",
      "--now",
      `${name}.service`,
    ]);
    const unitPath = scope === "system"
      ? `/etc/systemd/system/${name}.service`
      : `${home}/.config/systemd/user/${name}.service`;
    await Deno.remove(unitPath).catch(() => {});
    await runCommand(ctl[0], [...ctl.slice(1), "daemon-reload"]);
  } else {
    await runCommand("rc-service", [name, "stop"]);
    await runCommand("rc-update", ["del", name, "default"]);
    await Deno.remove(`/etc/init.d/${name}`).catch(() => {});
  }
  console.log(`已移除 ${name}。`);
}

async function main(): Promise<void> {
  const args = parse();
  const command = args.help ? "help" : String(args._[0] ?? "serve");

  switch (command) {
    case "serve":
      await runServer();
      return;
    case "genkey":
      console.log(generateMasterKeyBase64());
      return;
    case "version":
      console.log(`debot ${VERSION}`);
      return;
    case "help":
      console.log(HELP);
      return;
    case "install":
      await cmdInstall(args);
      return;
    case "uninstall":
      await cmdUninstall(args);
      return;
    case "start":
    case "stop":
    case "restart":
    case "status":
      await cmdServiceCtl(command, args);
      return;
    default:
      console.error(`未知命令：${command}`);
      console.log(HELP);
      Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
