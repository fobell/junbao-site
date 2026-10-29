import { readFile, writeFile, stat } from "node:fs/promises";
import { parseEnv } from "node:util";

if (!process.argv.includes("--include-secrets")) {
  console.log(
    "在生产服务器上执行 node scripts/credential-sheet.mjs --include-secrets，将实际密钥写入仅部署用户可读的 secrets/credential-sheet.local.json。不会将密钥输出到终端。不要把该文件放入源码包或公共存储。",
  );
} else {
  const folder = await stat("secrets");
  if ((folder.mode & 0o077) !== 0)
    throw new Error("secrets 目录必须为 0700；请先执行 chmod 700 secrets。");
  const env = parseEnv(await readFile(".env", "utf8"));
  const values = {};
  for (const name of [
    "database_password",
    "database_url",
    "encryption_key",
    "browser_token",
    "bootstrap_token",
    "backup_key",
  ]) {
    const value = (await readFile(`secrets/${name}`, "utf8")).trim();
    if (!value || (name !== "database_url" && !/^[a-f0-9]{64}$/i.test(value)))
      throw new Error(`secrets/${name} 缺失或不是本项目初始化器生成的格式。`);
    values[name] = value;
  }
  const dbUrl = new URL(values.database_url);
  if (decodeURIComponent(dbUrl.password) !== values.database_password)
    throw new Error("数据库 URL 与数据库密码文件不一致，停止导出。");
  const output = "secrets/credential-sheet.local.json";
  await writeFile(
    output,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        applicationUrl: env.APP_ORIGIN ?? "",
        databaseUser: "archive",
        databaseName: "archive",
        secrets: values,
        notes: {
          administrator:
            "在网页自行创建，没有默认用户名或默认密码。密码仅以哈希保存，无法导出原文。",
          totp: "验证器及一次性恢复码由管理员自行保管。",
          wechat: "AppID / AppSecret 在网页连接公众号时填写，不包含在本文件。",
          cloud:
            "阿里云 SSH / 控制台、域名管理和 R2 凭据由账户所有者自行保管，不包含在本文件。",
          restore:
            "恢复已有存档必须保留原 encryption_key 与 backup_key，不要用新随机值替换。",
        },
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    `已写入 ${output}（0600），终端未输出密钥。请转存到私有密码库；文件已存在时不会覆盖。`,
  );
}
