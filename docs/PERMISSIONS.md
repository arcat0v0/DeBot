# Credentials and permissions

DeBot stores every credential encrypted with AES-256-GCM under `DEBOT_DATA_DIR`.
You enter credentials through the `/profile` flow in Telegram. This document
lists the accepted input formats and the least-privilege IAM each provider
needs.

When adding a profile you first send a **name**, then the **credentials** blob
described below. You may paste JSON or the short space-separated form.

---

## AWS (EC2, Lightsail, Wavelength)

**Credential input**

```
<accessKeyId> <secretAccessKey> <region>
```

or JSON:

```json
{ "accessKeyId": "AKIA...", "secretAccessKey": "...", "region": "us-east-1" }
```

The region you set becomes the default the bot operates in. Change it later from
the service menu's **Region** button. For the AWS Wavelength service, the Region
button lists Wavelength Zones such as `us-east-1-wl1-bos-wlz-1`.

**IAM policy (least privilege)**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeImages",
        "ec2:DescribeInstanceTypeOfferings",
        "ec2:DescribeRegions",
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeRouteTables",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeCarrierGateways",
        "ec2:DescribeNetworkInterfaces",
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:RebootInstances",
        "ec2:TerminateInstances",
        "ec2:RunInstances",
        "ec2:AssociateVpcCidrBlock",
        "ec2:AssociateSubnetCidrBlock",
        "ec2:AssignIpv6Addresses",
        "ec2:ModifyAvailabilityZoneGroup",
        "ec2:CreateVpc",
        "ec2:ModifyVpcAttribute",
        "ec2:CreateSubnet",
        "ec2:CreateCarrierGateway",
        "ec2:CreateRouteTable",
        "ec2:AssociateRouteTable",
        "ec2:CreateRoute",
        "ec2:CreateSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:CreateTags",
        "sts:GetCallerIdentity",
        "ce:GetCostAndUsage",
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

**Balance / cost**

AWS does not expose a universal prepaid "balance" for every account type. DeBot
shows the AWS account ID through STS and, when Cost Explorer is enabled and the
IAM user has `ce:GetCostAndUsage`, the month-to-date unblended cost. If Cost
Explorer is disabled or denied, the bot keeps the account ID and displays a
permission warning.

**Wavelength minimal instance**

The built-in Wavelength create action chooses the selected Wavelength Zone, opts
the zone group in when needed, creates/reuses a DeBot-tagged VPC, Carrier
Gateway, Wavelength subnet, route table and SSH security group, then launches a
minimal `t3.medium` EC2 instance from the latest Amazon Linux 2023 x86_64 AMI.
The root EBS volume is forced to `gp2` for Wavelength compatibility, and the
network interface requests `AssociateCarrierIpAddress=true`; the returned
instance IP is the Carrier IP when AWS provides it.

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

`resourceGroup` is optional when the service principal is scoped at the
subscription level. Creation uses the credential resource group when present,
otherwise it uses the single accessible resource group when Azure returns
exactly one; if there is no unique existing group, it creates/uses `debot`.
Per-VM actions discover the resource group from the instance list; direct
firewall or lifecycle operations still need the VM to have been listed first or
the credential resource group to be set.

**Role**

Assign the service principal either a subscription-scoped **Contributor** role
or resource-group-scoped roles. Subscription-scoped Contributor lets DeBot query
subscription metadata, list restricted regions/SKUs and create the default
`debot` resource group. Resource-group scope is enough for managing existing VMs
inside that group.

Create a service principal:

```sh
az ad sp create-for-rbac --name debot \
  --role "Virtual Machine Contributor" \
  --scopes /subscriptions/<sub>/resourceGroups/<rg>
```

If you want DeBot to create VMs, add public IPv6, or manage Azure firewall
rules, also grant **Network Contributor** on the same resource group.

For Azure for Students, DeBot can:

- Query whether the subscription looks like a student subscription using Azure
  subscription policy fields such as `quotaId`.
- Query subscription balance. Azure may require billing-profile permissions for
  the exact credit balance; when those are not available, DeBot falls back to
  the current month cost query and shows the permission warning.
- Query regions where the student-free VM sizes are not restricted for the
  subscription.
- Create a default student VM from the built-in profile: `Standard_B1s`, falling
  back to other free student sizes only if needed, Ubuntu 22.04, 64 GiB Premium
  SSD, admin user `azureuser`, automatic resource group selection, and optional
  public IPv6.

Manual Azure creation without a saved preset uses:

```
name | region | resourceGroup | image | size | sshPublicKey | ipv6
```

Use `-` for optional `name` or `resourceGroup`; `ipv6` accepts `yes`/`no`.

**Firewall behavior**

Azure firewall management operates on the virtual machine's primary NIC Network
Security Group (NSG):

- Existing custom inbound rules on the NIC NSG are listed.
- Opening a port creates or updates an inbound allow rule.
- If the NIC has no NSG, DeBot creates `<vm-name>-nsg` and attaches it to that
  NIC. Azure's default NSG rules then deny other inbound ports unless explicit
  allow rules exist.
- Deleting a rule only removes custom rules from the NIC NSG.

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
