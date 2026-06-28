import { ValidationError } from "../shared/errors.ts";
import type {
  AwsCredentials,
  AzureCredentials,
  DigitalOceanCredentials,
  GcpCredentials,
  ProviderCredentials,
  ProviderId,
} from "../cloud/types.ts";

export interface ParsedCredentials {
  credentials: ProviderCredentials;
  defaultRegion?: string;
}

function tryJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new ValidationError("看起来是 JSON，但无法解析，请检查格式");
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseAws(text: string): ParsedCredentials {
  const json = tryJson(text);
  if (json) {
    const accessKeyId = str(json.accessKeyId) ?? str(json.aws_access_key_id);
    const secretAccessKey = str(json.secretAccessKey) ??
      str(json.aws_secret_access_key);
    const region = str(json.region) ?? str(json.defaultRegion);
    const sessionToken = str(json.sessionToken) ?? str(json.aws_session_token);
    if (!accessKeyId || !secretAccessKey) {
      throw new ValidationError("AWS 凭证需要 accessKeyId 和 secretAccessKey");
    }
    const credentials: AwsCredentials = { accessKeyId, secretAccessKey };
    if (sessionToken) credentials.sessionToken = sessionToken;
    return { credentials, defaultRegion: region };
  }
  const parts = text.trim().split(/[\s,]+/).filter((part) => part.length > 0);
  if (parts.length < 2) {
    throw new ValidationError(
      "请发送：AccessKeyID SecretAccessKey [区域]，或发送 JSON",
    );
  }
  return {
    credentials: { accessKeyId: parts[0], secretAccessKey: parts[1] },
    defaultRegion: parts[2],
  };
}

function parseAzure(text: string): ParsedCredentials {
  const json = tryJson(text);
  if (json) {
    const credentials: AzureCredentials = {
      tenantId: str(json.tenantId) ?? "",
      clientId: str(json.clientId) ?? str(json.appId) ?? "",
      clientSecret: str(json.clientSecret) ?? str(json.password) ?? "",
      subscriptionId: str(json.subscriptionId) ?? "",
    };
    const resourceGroup = str(json.resourceGroup);
    if (resourceGroup) credentials.resourceGroup = resourceGroup;
    if (
      !credentials.tenantId || !credentials.clientId ||
      !credentials.clientSecret || !credentials.subscriptionId
    ) {
      throw new ValidationError(
        "Azure 需要 tenantId、clientId、clientSecret 和 subscriptionId",
      );
    }
    return { credentials };
  }
  const parts = text.trim().split(/[\s,]+/).filter((part) => part.length > 0);
  if (parts.length < 4) {
    throw new ValidationError(
      "请发送：tenantId clientId clientSecret 订阅ID [资源组]",
    );
  }
  const credentials: AzureCredentials = {
    tenantId: parts[0],
    clientId: parts[1],
    clientSecret: parts[2],
    subscriptionId: parts[3],
  };
  if (parts[4]) credentials.resourceGroup = parts[4];
  return { credentials };
}

function parseGcp(text: string): ParsedCredentials {
  const json = tryJson(text);
  if (!json) {
    throw new ValidationError("请发送完整的 GCP 服务账号 JSON 密钥文件内容");
  }
  const projectId = str(json.project_id) ?? str(json.projectId);
  const clientEmail = str(json.client_email) ?? str(json.clientEmail);
  const privateKey = str(json.private_key) ?? str(json.privateKey);
  if (!projectId || !clientEmail || !privateKey) {
    throw new ValidationError(
      "GCP 服务账号 JSON 需要 project_id、client_email 和 private_key",
    );
  }
  const credentials: GcpCredentials = { projectId, clientEmail, privateKey };
  return { credentials };
}

function parseDigitalOcean(text: string): ParsedCredentials {
  const json = tryJson(text);
  const token = json ? str(json.token) : text.trim();
  if (!token) throw new ValidationError("请发送你的 DigitalOcean API Token");
  const credentials: DigitalOceanCredentials = { token };
  return { credentials };
}

export function parseCredentials(
  provider: ProviderId,
  text: string,
): ParsedCredentials {
  switch (provider) {
    case "aws":
      return parseAws(text);
    case "azure":
      return parseAzure(text);
    case "gcp":
      return parseGcp(text);
    case "digitalocean":
      return parseDigitalOcean(text);
  }
}
