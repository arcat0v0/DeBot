# Credentials and permissions

DeBot stores every credential encrypted with AES-256-GCM under `DEBOT_DATA_DIR`.
You enter credentials through the `/profile` flow in Telegram. This document
lists the accepted input formats and the least-privilege IAM each provider
needs.

When adding a profile you first send a **name**, then the **credentials** blob
described below. You may paste JSON or the short space-separated form.

---

## AWS (EC2 and Lightsail)

**Credential input**

```
<accessKeyId> <secretAccessKey> <region>
```

or JSON:

```json
{ "accessKeyId": "AKIA...", "secretAccessKey": "...", "region": "us-east-1" }
```

The region you set becomes the default the bot operates in. Change it later from
the service menu's **Region** button.

**IAM policy (least privilege)**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeRegions",
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:RebootInstances",
        "ec2:TerminateInstances",
        "ec2:RunInstances",
        "ec2:CreateTags",
        "lightsail:GetInstances",
        "lightsail:GetInstance",
        "lightsail:GetRegions",
        "lightsail:StartInstance",
        "lightsail:StopInstance",
        "lightsail:RebootInstance",
        "lightsail:DeleteInstance",
        "lightsail:CreateInstances"
      ],
      "Resource": "*"
    }
  ]
}
```

**Presets**

- EC2 `image` is an AMI id (`ami-...`), `size` is an instance type (`t3.micro`),
  `sshKeyId` is an existing EC2 key-pair name.
- Lightsail `image` is a blueprint id (`ubuntu_22_04`), `size` is a bundle id
  (`nano_3_0`), `sshKeyId` is a Lightsail key-pair name; `zone` is an
  availability zone (`us-east-1a`).

---

## Azure (virtual machines)

**Credential input**

```
<tenantId> <clientId> <clientSecret> <subscriptionId> <resourceGroup>
```

or JSON:

```json
{
  "tenantId": "...",
  "clientId": "...",
  "clientSecret": "...",
  "subscriptionId": "...",
  "resourceGroup": "my-rg"
}
```

`resourceGroup` is required for per-VM actions (start/stop/restart/delete) and
for creating VMs.

**Role**

Assign the service principal a scoped role on the resource group, e.g. the
built-in **Virtual Machine Contributor** plus **Network Contributor** (creation
provisions a public IP, virtual network and NIC). For read/lifecycle only,
Virtual Machine Contributor is sufficient.

Create a service principal:

```sh
az ad sp create-for-rbac --name debot \
  --role "Virtual Machine Contributor" \
  --scopes /subscriptions/<sub>/resourceGroups/<rg>
```

**Presets**

- `image` is `publisher:offer:sku:version`, e.g.
  `Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest`.
- `size` is a VM size (`Standard_B1s`).
- `sshKeyId` must be the **SSH public key text** (`ssh-rsa AAAA...`); the admin
  user is `azureuser`.

---

## Google Cloud (Compute Engine)

**Credential input**

Paste the entire service-account JSON key file. DeBot reads `project_id`,
`client_email` and `private_key`.

**Roles**

Grant the service account **Compute Instance Admin (v1)**
(`roles/compute.instanceAdmin.v1`) and **Service Account User**
(`roles/iam.serviceAccountUser`) on the project.

```sh
gcloud iam service-accounts create debot
gcloud projects add-iam-policy-binding <project> \
  --member="serviceAccount:debot@<project>.iam.gserviceaccount.com" \
  --role="roles/compute.instanceAdmin.v1"
gcloud iam service-accounts keys create key.json \
  --iam-account=debot@<project>.iam.gserviceaccount.com
```

**Presets**

- `image` is a source image
  (`projects/debian-cloud/global/images/family/debian-12`).
- `size` is a machine type (`e2-micro`).
- `zone` is required (`us-central1-a`).
- `sshKeyId` is an SSH public key added to instance metadata as `debot:<key>`.
- Renaming is not supported by GCP.

---

## DigitalOcean (droplets)

**Credential input**

Send your API token (a single line), or `{ "token": "dop_v1_..." }`.

Create a token in the DigitalOcean control panel with **read + write** scope
(API → Tokens).

**Presets**

- `image` is a slug (`ubuntu-22-04-x64`).
- `size` is a size slug (`s-1vcpu-1gb`).
- `region` is required (`nyc3`).
- `sshKeyId` is a DigitalOcean SSH key id or fingerprint.

---

## Preset format

When adding a preset via `/presets` send one line:

```
name | image | size | region | zone | sshKeyId
```

`region`, `zone` and `sshKeyId` are optional — use `-` to skip a field.
