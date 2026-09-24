# Private home deployment options

These notes preserve the September 23, 2026 deployment discussion. They describe proposed options, not a deployed service or a new supported installation path. The current supported path remains [npm → Docker Compose → LiteLLM](installation.md). No cloud resources were provisioned. Recheck prices and provider requirements before purchasing hosting.

## Why consider moving work off the desktop?

A controlled fictional workload on an 8 GiB Mac completed in about 470 seconds before disabling Docker Desktop background Scout indexing and 95 seconds afterward. Proxy startup changed from approximately 59/130 seconds on initial/recreated containers to 10/10 seconds. Application memory remained similar. This supports desktop contention as a major contributor to that development slowdown.

This was one sequential comparison, with differences in caches and other background activity. It does not isolate the entire improvement to Scout, establish minimum RAM, or measure autonomous extraction with a real provider. Cloud hosting can remove local contention; it does not remove provider latency and can add transfer time. The observations below are historical measurements, not independently reproduced release evidence.

## Placement choices

- **Keep both services local.** No new hosting bill. The app, PDF workers, LiteLLM and Docker Desktop continue sharing the Mac with other applications. The indexing change may already provide sufficient relief.
- **Keep the app and archive local; move LiteLLM to a private server.** The local app backend sends model requests over authenticated VPN/HTTPS to the cloud proxy. This removes the proxy workload from the Mac and permits independent proxy updates. The observed proxy container accounted for roughly 0.9 GiB including file cache; this is not a promise of an equal reduction in host resident memory. Local Docker and PDF processing remain.
- **Move both services to a private server.** Household devices use a browser over private HTTPS. One server can host separately managed app and proxy services; independent updates do not require two servers. The server stores the encrypted archive and performs PDF processing and decryption.

With a local archive and remote proxy, submitted prompts, PDF pages, images and tool results still pass through the cloud proxy and model provider. Keeping the complete archive local does not keep all inference content local. Disable request-body logging and avoid retaining model payloads at the gateway.

With the app hosted remotely, the server handles unlock material and reads decrypted records during use. Encryption at rest does not protect an unlocked archive from a compromised server or its administrator. This deployment is not zero-knowledge hosting.

LiteLLM can have a slower, independent release cadence than the application. It still needs security patches, provider compatibility updates and qualification after relevant changes.

## Proposed DigitalOcean setup

Start with one Ubuntu LTS Droplet running Docker Engine and Compose, a service supervisor, pinned images built outside the small production server, and explicit update/rollback procedures. Use persistent Linux directories for encrypted data and credential state, with a separate tmpfs workspace for plaintext runtime files. Preserve the [filesystem and single-writer contracts](deployment.md#filesystem-and-process-requirements).

Expose access only through an authenticated private network such as Tailscale, with deliberate user/device grants and MFA. Keep the app, model API and proxy administration ports off the public interface. Use a cloud firewall and a stable HTTPS hostname, with matching Origin and WebAuthn configuration. Tailscale Serve can provide private HTTPS; changing `HEALTH_PUBLIC_ORIGIN` alone does not configure TLS or access control. See [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) and [DigitalOcean Cloud Firewalls](https://www.digitalocean.com/products/cloud-firewalls).

DigitalOcean App Platform is not a drop-in target for the current storage design: its local filesystem is ephemeral and persistent volumes are unsupported. A Droplet supplies the filesystem control the application expects. Kubernetes, a load balancer and a managed database are not necessary for this initial household design. See [App Platform limits](https://docs.digitalocean.com/products/app-platform/details/limits/).

## Household admission and token protection

Keep this a private household service with owner-controlled enrollment. Public registration would require a separate account/tenant, authorization, resource-isolation and quota design.

- **Control network admission.** Only approved devices and users should reach the app or proxy. A private network is an outer boundary; application authorization still matters for admitted users.
- **Separate credentials.** Provider keys and the LiteLLM master key stay on the gateway server. Give the app backend a revocable credential limited to permitted inference routes and model aliases. Never embed these secrets in browser JavaScript. This restricted credential/front-door design must be implemented and verified before remote use.
- **Bound spending and resource use.** Apply tested request, rate and concurrency limits; disable unneeded admin routes; monitor usage and support revocation. Do not assume a billing alert is a hard spending cap.
- **Gate enrollment and paid probes.** Current ordinary profile creation and some model connection tests are reachable before profile login. Recovery proof establishes ability to unlock a profile, not permission to join the household or spend its model quota.
- **Preserve the household boundary.** The current profile picker exposes names and profile metadata, and unlocking a profile revokes access to the previously active profile. Independent users may need separate instances. This is not an existing multi-tenant hosting service.

Full LiteLLM virtual-key management, per-key budgets and spend tracking require PostgreSQL. The current launcher deliberately rejects proxy databases and payload logging. Introducing those features needs a separate metadata-retention, privacy and sizing decision. A minimal household gateway can instead use private-network admission and a restricted inference front door without that database. See [LiteLLM virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys) and the current [proxy configuration restrictions](../deploy/litellm/configure.py).

## Changes and checks needed before deployment

This design is tracked as deferred work in [CRS-083](application-todo.md#crs-083); maintain task status in that single list.

The backend accepts an HTTP(S) proxy origin, but [Compose](../compose.yaml) and the launcher currently couple the app to a local LiteLLM service and shared lifecycle. A supported remote-proxy option needs protected credential provisioning, startup/availability handling and independently qualified updates. Changing a URL alone does not complete that work.

Before remote access, address the admission controls above and review the current [session implementation](../src/server/vault-app.ts): cookies currently omit `Secure`, and sessions lack server-side expiry. Verify HTTPS, cookie security, session expiry/rotation, exact Origin behavior and passkey enrollment on the intended hostname. Moving to a new hostname requires recovery and passkey enrollment for that origin.

Keep secrets separate from archive data; disable payload logging; use consistent encrypted archive backups with recovery kits stored separately. Back up provider authentication state separately. Full-server backups can include provider credentials if those credentials reside on the backed-up disk. Practice a fictional restore, original download and cache-loss rebuild; see [backup and recovery](deployment.md#backup-and-recovery).

Qualify the exact provider route and authentication on the proposed host. Do not assume subscription authentication is portable or already verified. Preserve PDF-first delivery after runtime capability proof, with the existing lossless PNG fallback when native PDF delivery is unsupported or unsafe. Startup capability checks do not establish representative extraction quality or cache savings. The [provider gates](model-providers.md) and [application work list](application-todo.md) remain open where real providers, documents or devices are required.

## Monthly planning estimates

USD reference prices checked September 23, 2026 for DigitalOcean Basic Regular Droplets. These are hosting estimates, not measured capacity guarantees:

- **Remote LiteLLM only:** 1 vCPU, 2 GiB RAM, 50 GiB SSD: $12/month; $14.40 with weekly backups or $15.60 with daily backups.
- **Both services, pilot:** 2 vCPUs, 4 GiB RAM, 80 GiB SSD: $24/month; $28.80 with weekly backups or $31.20 with daily backups.
- **Both services, more headroom:** 4 vCPUs, 8 GiB RAM, 160 GiB SSD: $48/month; $57.60 with weekly backups or $62.40 with daily backups.

The referenced basic backup plans add 20% for weekly backups or 30% for daily backups. Model/provider charges, taxes, optional domains, extra storage and transfer overages are excluded. External inference needs no local GPU. See [Droplet pricing](https://www.digitalocean.com/pricing/droplets) and [backup pricing](https://docs.digitalocean.com/products/backups/details/pricing/).

Tailscale's referenced Personal plan is free for eligible noncommercial use with up to six users. A private Tailscale HTTPS name may avoid buying a domain. Recheck [plan eligibility and limits](https://tailscale.com/pricing).

The 4 GiB whole-stack option is a pilot hypothesis below the project's conservative [8 GiB host / 4 GiB available-to-Docker planning guidance](installation.md). It does not revise that guidance. Qualify peak worker memory, runtime workspace capacity, realistic archive sizes, note export and complete imports before relying on either server size.

## Recommendation to revisit

First assess ordinary use with background indexing disabled. If the goal remains to keep the archive local while giving LiteLLM an independent lifecycle, prototype the private remote proxy at roughly $15/month including weekly backups. If the goal is to remove application processing from the Mac entirely, test both services on one private server; budget roughly $29/month for the pilot or $58/month for more headroom, plus inference charges.

Choose only after a fictional end-to-end deployment and restore test. These notes do not authorize public signup, provision a server, change the supported runtime, or close any release gate.
