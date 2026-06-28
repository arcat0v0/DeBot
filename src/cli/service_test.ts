import { assert, assertEquals } from "@std/assert";
import {
  buildPlan,
  openrcScript,
  resolveExec,
  type ServiceOptions,
  systemdUnit,
} from "./service.ts";

function opts(): ServiceOptions {
  return {
    name: "debot",
    description: "DeBot",
    workdir: "/opt/debot",
    envFile: "/opt/debot/.env",
    exec: { bin: "/opt/debot/debot", args: ["serve"] },
    user: "deploy",
  };
}

Deno.test("resolveExec handles source mode (deno)", () => {
  const spec = resolveExec("file:///proj/src/cli.ts", "/usr/bin/deno");
  assertEquals(spec.bin, "/usr/bin/deno");
  assertEquals(spec.args[0], "run");
  assertEquals(spec.args.includes("--allow-run"), true);
  assertEquals(spec.args.at(-2), "/proj/src/cli.ts");
  assertEquals(spec.args.at(-1), "serve");
});

Deno.test("resolveExec handles a compiled binary", () => {
  const spec = resolveExec("file:///whatever", "/opt/debot/debot");
  assertEquals(spec.bin, "/opt/debot/debot");
  assertEquals(spec.args, ["serve"]);
});

Deno.test("resolveExec honours an override", () => {
  const spec = resolveExec("x", "y", "/custom/bin serve --flag");
  assertEquals(spec.bin, "/custom/bin");
  assertEquals(spec.args, ["serve", "--flag"]);
});

Deno.test("systemdUnit user scope omits User and targets default.target", () => {
  const unit = systemdUnit(opts(), "user");
  assert(unit.includes("WantedBy=default.target"));
  assert(unit.includes("ExecStart=/opt/debot/debot serve"));
  assert(unit.includes("EnvironmentFile=-/opt/debot/.env"));
  assert(!unit.includes("User="));
});

Deno.test("systemdUnit system scope sets User and multi-user target", () => {
  const unit = systemdUnit(opts(), "system");
  assert(unit.includes("User=deploy"));
  assert(unit.includes("WantedBy=multi-user.target"));
});

Deno.test("openrcScript runs as the configured user", () => {
  const script = openrcScript({ ...opts(), group: "deploy" });
  assert(script.startsWith("#!/sbin/openrc-run"));
  assert(script.includes('command="/opt/debot/debot"'));
  assert(script.includes('command_args="serve"'));
  assert(script.includes('command_user="deploy:deploy"'));
});

Deno.test("buildPlan systemd user writes a user unit and enables it", () => {
  const plan = buildPlan(opts(), {
    init: "systemd",
    scope: "user",
    home: "/home/deploy",
    linger: false,
    start: true,
  });
  assertEquals(
    plan.files[0].path,
    "/home/deploy/.config/systemd/user/debot.service",
  );
  assert(
    plan.commands.some((c) => c.join(" ") === "systemctl --user daemon-reload"),
  );
  assert(
    plan.commands.some((c) =>
      c.join(" ") === "systemctl --user enable --now debot.service"
    ),
  );
});

Deno.test("buildPlan adds lingering when requested", () => {
  const plan = buildPlan(opts(), {
    init: "systemd",
    scope: "user",
    home: "/home/deploy",
    linger: true,
    start: true,
  });
  assert(
    plan.commands.some((c) => c.join(" ") === "loginctl enable-linger deploy"),
  );
});

Deno.test("buildPlan skip-start enables without starting", () => {
  const plan = buildPlan(opts(), {
    init: "systemd",
    scope: "user",
    home: "/home/deploy",
    linger: false,
    start: false,
  });
  assert(
    plan.commands.some((c) =>
      c.join(" ") === "systemctl --user enable debot.service"
    ),
  );
  assert(!plan.commands.some((c) => c.includes("--now")));
});

Deno.test("buildPlan openrc writes an executable init script", () => {
  const plan = buildPlan(opts(), {
    init: "openrc",
    scope: "system",
    home: "/home/deploy",
    linger: false,
    start: true,
  });
  assertEquals(plan.files[0].path, "/etc/init.d/debot");
  assertEquals(plan.files[0].mode, 0o755);
  assert(
    plan.commands.some((c) => c.join(" ") === "rc-update add debot default"),
  );
  assert(plan.commands.some((c) => c.join(" ") === "rc-service debot start"));
});
