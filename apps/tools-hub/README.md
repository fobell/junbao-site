# 钧宝工具箱

公开入口：[tools.junbao.ai](https://tools.junbao.ai/)。各工具负责自己的登录和权限。此目录只提供静态 HTML、CSS 与图片，无后台进程、数据库、跟踪脚本或统一登录。

## 添加工具

编辑 `tools.json`，增加一个条目：

```json
{
  "id": "your-tool",
  "name": "工具名称",
  "category": "用途分类",
  "description": "说明工具能完成什么。",
  "url": "/your-tool/",
  "icon": "your-tool.svg",
  "access": "需要登录",
  "order": 20
}
```

图标放入 `public/`；`id` 唯一，`order` 越小越靠前。地址可为站内路径或完整 HTTPS 地址。条目只负责导航；新工具自身的安装、路径适配和 Caddy 转发需随该工具单独完成。不要先放尚未可用的入口。

从仓库根目录运行 `node apps/tools-hub/build.mjs`，预览生成的 `dist/`。构建会验证清单，输出文件不提交 Git。字体使用主站同风格的本机衬线标题和中文无衬线正文，无外部字体请求。

## 发布

将构建产物上传至服务器临时发布目录后，在服务器运行：

```bash
bash server/publish-tools-hub.sh /path/to/uploaded/dist release-id
```

脚本发布至 `/var/www/junbao.ai/tools-hub/releases/release-id` 并原子切换 `current`。该目录位于 Caddy 已有的只读挂载内，与个人主站的 `current` 目录并列，主站同步程序不会覆盖它。不需要重启 Caddy；首次配置站点分流参见 [文藏部署说明](../wechat-archive/docs/tools-junbao.md)。

回滚汇总页：在服务器将 `/var/www/junbao.ai/tools-hub/current` 的符号链接切回此前的发布目录。仅调整工具清单和页面时不需要重建文藏或更新其数据库。
