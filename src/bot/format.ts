import type { Instance, InstanceState } from "../cloud/types.ts";
import type { JobRecord } from "../jobs/types.ts";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function code(text: string): string {
  return `<code>${escapeHtml(text)}</code>`;
}

export function bold(text: string): string {
  return `<b>${escapeHtml(text)}</b>`;
}

export function stateEmoji(state: InstanceState): string {
  switch (state) {
    case "running":
      return "🟢";
    case "stopped":
      return "🔴";
    case "pending":
    case "rebooting":
      return "🟡";
    case "stopping":
    case "terminating":
      return "🟠";
    case "terminated":
      return "⚫";
    default:
      return "⚪";
  }
}

export function stateLabel(state: InstanceState): string {
  switch (state) {
    case "running":
      return "运行中";
    case "stopped":
      return "已停止";
    case "pending":
      return "启动中";
    case "rebooting":
      return "重启中";
    case "stopping":
      return "停止中";
    case "terminating":
      return "删除中";
    case "terminated":
      return "已销毁";
    default:
      return "未知";
  }
}

export function instanceButtonLabel(instance: Instance): string {
  return `${stateEmoji(instance.state)} ${instance.name || instance.id}`;
}

export function instanceDetail(
  instance: Instance,
  providerLabel: string,
): string {
  const lines: string[] = [];
  lines.push(
    `${stateEmoji(instance.state)} ${bold(instance.name || instance.id)}`,
  );
  lines.push(
    `${escapeHtml(providerLabel)} · ${escapeHtml(stateLabel(instance.state))}`,
  );
  lines.push("");
  lines.push(`ID：${code(instance.id)}`);
  if (instance.region) lines.push(`区域：${code(instance.region)}`);
  if (instance.zone) lines.push(`可用区：${code(instance.zone)}`);
  if (instance.size) lines.push(`规格：${code(instance.size)}`);
  if (instance.image) lines.push(`镜像：${code(instance.image)}`);
  if (instance.publicIp) lines.push(`公网 IP：${code(instance.publicIp)}`);
  if (instance.privateIp) lines.push(`内网 IP：${code(instance.privateIp)}`);
  if (instance.createdAt) lines.push(`创建时间：${code(instance.createdAt)}`);
  const tagKeys = Object.keys(instance.tags ?? {});
  if (tagKeys.length > 0) {
    lines.push(`标签：${escapeHtml(tagKeys.join(", "))}`);
  }
  return lines.join("\n");
}

export function jobLine(job: JobRecord): string {
  const icon = job.status === "succeeded"
    ? "✅"
    : job.status === "failed"
    ? "❌"
    : job.status === "running"
    ? "⏳"
    : "•";
  const detail = job.status === "failed" && job.error
    ? ` — ${escapeHtml(job.error)}`
    : job.status === "succeeded" && job.result
    ? ` — ${escapeHtml(job.result)}`
    : "";
  return `${icon} ${escapeHtml(job.label)}${detail}`;
}
