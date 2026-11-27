# Azure deployment plan (planning only)

Status: **planning only. Nothing was provisioned, deployed or modified in Azure or Vercel.**
The Bicep file in `infra/main.bicep` is a draft for review. It has not been compiled or validated with `az bicep build`, because the Bicep CLI is not installed and installing it was out of scope. Resource API versions must be checked against the provider schema before any use.

The local stack this plan maps to is described in [LOCAL_AI_TEST_REPORT.md](LOCAL_AI_TEST_REPORT.md).

## 1. Target architecture

| Concern | Local (today) | Azure target (planned) |
| --- | --- | --- |
| API | FastAPI in container `smashlab-ai-api`, port 8000 | Azure Container Apps app `smashlab-api`, external ingress, minimum 1 replica |
| Analysis worker | Thread inside the API container, SQLite queue | Azure Container Apps Job `smashlab-worker`, event-triggered by Azure Queue Storage, one replica per message |
| Job state | SQLite on named volume `smashlab-ai-db` | Azure Table Storage (or Cosmos DB serverless if query needs grow); same `JobRecord` fields |
| Queue | SQLite `queue_messages` table (Azure-style lease semantics) | Azure Queue Storage `analysis-jobs`; the `JobQueue` protocol in `backend/app/services/store.py` gets an adapter |
| Uploads | `outputs/<job>/input/` bind mount | Blob container `uploads` with 7-day lifecycle deletion |
| Artifacts | `outputs/<job>/` bind mount | Blob container `outputs`; API streams via managed identity or returns short-lived SAS |
| Models | `./models` bind mount, read-only | Baked into the image at build time (licence files kept) or Azure Files share, read-only |
| Images | local `smashlab-ai-backend:local` | Azure Container Registry (Basic), pulled with a user-assigned managed identity (AcrPull) |
| Secrets | none in the backend | none: managed identity for ACR, Storage and Queue; no account keys |
| Logs and metrics | `docker logs`, `/health` | Log Analytics workspace, Container Apps console logs, Azure Monitor alert on job failures |
| Frontend | `npm run dev` on localhost:3000 | Vercel (existing). The server-only `SMASHLAB_API_URL` points to the Container Apps FQDN |

Video stays inside the user's own Azure resource group during processing. The local-only rule in `AGENTS.md` still applies to the local stack. Any cloud upload path is a separate, explicitly approved decision, not part of this plan.

## 2. Resources in `infra/main.bicep`

- `Microsoft.ManagedIdentity/userAssignedIdentities`: one identity for the API and the worker.
- `Microsoft.ContainerRegistry/registries` (Basic, admin user disabled).
- `Microsoft.Storage/storageAccounts` (Standard_LRS, TLS 1.2, shared-key access disabled), blob containers `uploads` and `outputs`, lifecycle rule for uploads, queue `analysis-jobs`.
- `Microsoft.OperationalInsights/workspaces` (30 days retention).
- `Microsoft.App/managedEnvironments` with a Consumption profile and an optional GPU profile (off by default).
- `Microsoft.App/containerApps` (API) with CORS limited to the Vercel origin parameter.
- `Microsoft.App/jobs` (worker) with an Azure Queue scale rule.
- Role assignments: AcrPull on the registry; Storage Blob Data Contributor and Storage Queue Data Contributor on the storage account.

## 3. Identity and access

- No account keys or connection strings in configuration. The services use `AZURE_CLIENT_ID` with `DefaultAzureCredential`.
- The Vercel frontend never receives a server secret. `SMASHLAB_API_URL` and `SMASHLAB_API_TOKEN` are read on the server only and never carry a `NEXT_PUBLIC_` prefix.
- The API accepts CORS only from the configured origin. Upload size and duration limits stay as in the local stack (200 MB, 120 s).
- Uploads and outputs are private containers. Artifact downloads go through the API or short-lived SAS links.

## 4. Queue and job semantics

- Enqueue writes a message containing the job id. Job state is written before enqueue.
- The worker receives a message with a visibility timeout (lease). If it crashes, the message reappears after the lease. The job then retries, up to `SMASHLAB_MAX_ATTEMPTS` (default 2).
- The worker deletes the message only after the job state is terminal (`completed` or `failed`).
- The job limit (`job_timeout_s` floor 1200 s, growing to 3900 s for a 120 s clip) is enforced inside the pipeline. The Container Apps Job `replicaTimeout` must be set above the longest limit (the draft's 1800 s is too short for long clips).

## 5. Cost estimate (inputs and method)

Planning arithmetic only. Nothing was priced against a live subscription.

**Rates (provisional).** A third-party guide quoted about USD 0.000024 per active vCPU-second, USD 0.000003 per GiB-second of memory and USD 0.40 per million requests (East US, unverified; https://www.devzero.io/blog/azure-container-apps-pricing). The official page (https://azure.microsoft.com/pricing/details/container-apps/) did not show usable values during this session. Confirm all rates with the Azure Retail Prices API before any budget decision.

**Measured inputs.** The final end-to-end run (five jobs, CPU-only Docker stack; [LOCAL_AI_TEST_REPORT.md](LOCAL_AI_TEST_REPORT.md), section 11):

- Pipeline wall time per 15 s clip: 157–171 s on the four clean runs. Job A took 250 s while host lint and test commands ran, so it is an upper bound.
- Process CPU time: 580–621 s on the clean runs and 852 s for job A. The process kept 3.4–3.7 of the 4 container CPUs busy.
- Peak RSS: 1.03–1.24 GB.

**Billing basis.** Container Apps bills the vCPU and memory allocated to a running replica or job execution, not the CPU the process actually uses. Measured CPU time therefore sizes the worker; it does not set the price. Confirm this on the rate card.

**Worker sizing.** The draft in `infra/main.bicep` gives the worker 2 vCPU and 4 GiB. A process that keeps about 3.7 cores busy cannot finish on 2 vCPU faster than its CPU seconds ÷ 2: about 290–310 s for the clean runs and about 430 s for job A. The 2 vCPU figure needs a test on a 2 vCPU worker before it is relied on.

**Compute per 15 s clip at the provisional rates:**

| Worker | Wall time | Compute cost per clip |
| --- | --- | --- |
| 2 vCPU, 4 GiB | 290–430 s (CPU-bound) | USD 0.017–0.026 |
| 4 vCPU, 8 GiB | 157–171 s (measured with 4 cores) | USD 0.019–0.021 |

The 4 vCPU, 8 GiB shape must be checked against the current Consumption-plan limits.

**Always-on API replica.** The draft gives the API 1 vCPU and 2 GiB with a minimum of one replica. At the active rate over a 30-day month, 2,592,000 s × (1 × 0.000024 + 2 × 0.000003) ≈ USD 78. That equals the compute for roughly 2,600 to 4,600 clips at these rates. Idle pricing, if it applies to this workload, would be lower. Confirm before budgeting.

Storage, container registry, log ingestion and the API replica are separate line items. Recompute with the official rate card before any budget decision.

GPU profile: not measured. The local backend is CPU-only, and this Mac has no NVIDIA GPU. A GPU build would need `onnxruntime-gpu` and a CUDA-capable image. That path is untested and is not included in the cost figures.

## 6. Readiness checklist

| Item | Status |
| --- | --- |
| Container image builds from `backend/Dockerfile` (CPU, no torch) | Done locally |
| `/health` reports models, ffmpeg, worker, queue depth | Done locally |
| Durable job state and queue with lease semantics | Done locally (SQLite); Azure adapter not written |
| Azure Queue Storage adapter implementing `JobQueue` | Not implemented |
| Worker entry point for Container Apps Jobs (`app.services.azure_worker`) | Not implemented |
| Blob-backed input and output storage | Not implemented (local bind mounts only) |
| Managed identity code path (`DefaultAzureCredential`) | Not implemented |
| Bicep compiled and reviewed | Not done (draft only) |
| Resource API versions verified | Not done |
| Azure Monitor alert on failed jobs | Not configured |
| Load and cost test on Azure | Not done |
| Vercel production origin set in `allowedOrigin` | Placeholder only |
| Legal review of TrackNetV3 (MIT) and YOLOX (Apache-2.0) redistribution in an image | Licence files are kept; review before shipping |
| CC BY-SA and CC BY attribution for any sample redistributed | Not applicable while samples stay local |

## 7. Out of scope for this plan

- Deploying to Azure or Vercel (explicitly not done).
- Any cloud video pipeline. Video processing in the cloud would change the local-only rule in `AGENTS.md` and needs a separate decision.
- Shot classification and shuttle speed in physical units. Neither is supported by the current pipeline. Rally candidates are heuristic, not validated, and not evaluated against ground truth. Player identities are logical labels with manual correction, and they are not face recognition.
