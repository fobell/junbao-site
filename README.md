# junbao.ai

Personal site of 钧宝 JUNBAO. Static files live in `site/`.

The server pulls `main` every 2 minutes (`server/junbao-sync`, installed by `server/setup.sh`), so a push to `main` goes live automatically.

## tools.junbao.ai

[钧宝工具箱](https://tools.junbao.ai/) is a public static directory in `apps/tools-hub/`. Update its tool manifest to add a working tool; see [catalog maintenance and publishing](apps/tools-hub/README.md).

[文藏](https://tools.junbao.ai/wechat-article-archive/) lives in `apps/wechat-archive/` and runs as a separate Docker Compose project behind the existing Caddy gateway. Its API, images and downloads share the same path prefix. Each tool owns its authentication.

The personal-site sync only copies `site/`; hub and application releases are independent. See [deployment and recovery](apps/wechat-archive/docs/tools-junbao.md). Production credentials and data are never committed.

The [initial verification record](apps/wechat-archive/docs/production-verification-2026-10-30.md) documents the original root deployment; the [path migration record](apps/wechat-archive/docs/tools-path-migration.md) covers the tools directory and new application address.
