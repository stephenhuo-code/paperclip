# ADR 0001: Slim the production image for the Alibaba Cloud deployment

- Status: Accepted
- Date: 2026-10-15
- Decision owners: Alibaba Cloud deployment (deploy/aliyun)

## Context

The first deploy pushes the Paperclip image from GitHub Actions to ACR
(personal edition, cn-hangzhou). The image is 9.33 GB as Docker reports it.
With the build cache warm, the build took about 4 minutes and the cache export
about 1.5 minutes, but the cross-border push to ACR did not finish within the
2-hour job limit (run of commit `ad819626d`).

Measured inside the image (uncompressed):

| Part | Size | Used by this deployment |
|---|---|---|
| `/app` (monorepo build output) | 3.2 GB, of which `node_modules` 2.6 GB | yes |
| Global agent CLIs layer | 1.7 GB | partly |
| - npm download cache `/root/.npm` left by the install | 618 MB | no |
| - `@openai/codex` | 390 MB | yes |
| - `@anthropic-ai/claude-code` | 244 MB | yes (DeepSeek, MiniMax via `claude_local`) |
| - `opencode-ai` | 177 MB | no |
| - `@google/gemini-cli` | 98 MB | no |
| - `@moonshot-ai/kimi-code` | 57 MB | yes (`kimi_local`) |
| Runner provider pack `/opt/paperclip-runner/provider-pack` | 1.5 GB | no |

The provider pack only serves Paperclip runner remote sandboxes running
OpenCode or ACPX. `claude_local` and `kimi_local`, including their SSH
execution environments, do not use it. Upstream already supports an image
without a pack: builds with no `PAPERCLIP_BUILD_COMMIT` skip it.

## Decision

1. Remove the npm cache in the same layer that installs the global CLIs
   (`npm cache clean --force`).
2. Add the build argument `CLI_TOOLS`. Its default is the upstream list of five
   CLIs. This deployment installs only Claude Code, Codex and Kimi Code.
3. Add the build argument `PAPERCLIP_SKIP_PROVIDER_PACK`. Its default keeps the
   upstream behaviour. This deployment sets it to `true`.

The defaults keep upstream builds unchanged. Only
`.github/workflows/deploy-aliyun.yml` passes the slim values. Expected saving:
about 2.4 GB.

Not done, and why:

- `.dockerignore` and multi-stage builds: already in place (`.git`, `.github`
  and `node_modules` are excluded; the production stage copies build output
  only). CI builds start from a clean checkout.
- Pruning `/app/node_modules` to production dependencies: Paperclip loads
  every adapter at startup and workspace packages depend on each other, so
  pruning risks startup failures. Revisit separately if needed.
- Building on the ECS instance instead of pushing across the border: decide
  after measuring the push of the slimmed image.

## Consequences

- OpenCode and Gemini agents cannot run in the production image, and runner
  remote sandboxes (OpenCode/ACPX) are unavailable. To restore them, drop the
  two build arguments from the deploy workflow.
- Two upstream `Dockerfile` spots change (the CLI install `RUN` and the
  provider-pack stage). Re-check them when merging upstream.
- Local images for the test stack should be built with the same arguments to
  match production.
