# junbao.ai

Personal site of 钧宝 JUNBAO. Static files live in `site/`.

The server pulls `main` every 2 minutes (`server/junbao-sync`, installed by `server/setup.sh`), so a push to `main` goes live automatically.

## tools.junbao.ai

The WeChat archive application lives in `apps/wechat-archive/`. It runs as a separate Docker Compose project behind the existing Caddy gateway. The static-site sync above only copies `site/`; application releases require the documented build, migration and verification workflow.

See [deployment and recovery](apps/wechat-archive/docs/tools-junbao.md). Production credentials and data are never committed.
