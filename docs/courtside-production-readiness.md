# Courtside production wiring: disabled scaffold

`infra/app/courtside.production.disabled.yml` is a reviewable Compose scaffold, not a deployment command. It must not be added to the production workflow as-is: GPU processing, video rendering and recording relay are deliberately disabled, and the worker has no network. Existing FPC services are not changed by this file unless an operator explicitly includes it.

Before enabling the service, establish and verify all of the following:

- An EFS-backed dedicated store with correct ownership, backup and tested restore; provision it separately and preserve existing FPC/Courtside data. The API and worker must mount the same store and agree on its identity.
- An immutable, independently verified export of the reviewed Git SHA, mounted read-only, and a worker image pinned to a reviewed digest. Verify source/image provenance immediately before rollout.
- A production T4 identity with least privilege and restricted egress; there are no credentials or network routes in this scaffold. Do not reuse a forwarded developer SSH agent for a permanent service.
- Match-scoped, authenticated recording relay with existing S3 credentials; validate region, access, resumed transfer and cache retention. The scaffold deliberately keeps relay off.
- An authenticated same-case browser test from intake through T4, reviewed poses, video and PDF creation/download, then a rehearsal of backup, rollback and a deploy window that will not interrupt FPC recording.

`COURTSIDE_STORE_HOST`, `COURTSIDE_RELEASE_ROOT`, `COURTSIDE_WORKER_IMAGE` and `COURTSIDE_PUBLIC_ORIGIN` have no defaults. Validate their paths, ownership, EFS mount, image digest, release SHA and HTTPS origin before using them. Both protected feature gates must remain off until the preceding tests and network/identity work are complete.
