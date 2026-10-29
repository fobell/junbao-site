import { db, one, transaction, type Row } from "./db.js";
import { seal, unseal } from "./security.js";
import { safeFetch, canonicalArticle } from "./network.js";
import { config } from "./config.js";
import {
  AppError,
  type ArticleRef,
  type SourceAdapter,
  type SourcePage,
} from "../shared/types.js";
export function wechatError(code: number): AppError {
  if ([40001, 40014, 42001, 200003].includes(code))
    return new AppError("AUTH_EXPIRED", "微信凭据已失效，请重新连接", 409);
  if ([45009, 45011, 200013].includes(code))
    return new AppError("RATE_LIMIT", "微信请求频率受限，已暂停获取", 429);
  if (code === 40164)
    return new AppError(
      "IP_NOT_ALLOWED",
      "请将服务器出口 IP 加入公众号开发者 IP 白名单",
      409,
    );
  if (code === 48001)
    return new AppError(
      "API_UNAUTHORIZED",
      "该账号尚未获得此接口权限，可连接后台补充",
      409,
    );
  return new AppError(
    "WECHAT_ERROR",
    `微信接口返回错误码 ${code}`,
    502,
    code === -1,
  );
}
export function flattenOfficial(result: any): SourcePage {
  if (!Array.isArray(result.item) || typeof result.total_count !== "number")
    throw new AppError(
      "SOURCE_SCHEMA_CHANGED",
      "微信列表结构变化，停止本次核对",
      502,
    );
  const items: ArticleRef[] = [];
  for (const message of result.item) {
    if (!message.article_id || !Array.isArray(message.content?.news_item))
      throw new AppError("SOURCE_SCHEMA_CHANGED", "微信图文结构变化", 502);
    message.content.news_item.forEach((n: any, index: number) => {
      const url = n.url ?? n.article_url ?? "";
      let canonical;
      try {
        canonical = canonicalArticle(url);
      } catch {}
      const sourceId = `${message.article_id}:${index + 1}`;
      items.push({
        key: canonical?.key ?? `official:${sourceId}`,
        url: canonical?.url ?? "",
        biz: canonical?.biz,
        source: "official",
        sourceId,
        title: n.title || "未命名文章",
        author: n.author || null,
        publishedAt: null,
        updatedAt: message.update_time
          ? new Date(message.update_time * 1000).toISOString()
          : null,
        html: n.content,
        deleted: !!n.is_deleted,
      });
    });
  }
  return {
    items,
    cursor: null,
    ended: false,
    totalMessages: result.total_count,
    messageCount: result.item.length,
    evidence: "official_api",
  };
}
export class OfficialApiAdapter implements SourceAdapter {
  constructor(public account: Row) {}
  async token() {
    return transaction(async (conn) => {
      await conn.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `token:${this.account.id}`,
      ]);
      const c = await one(
        "SELECT * FROM connections WHERE account_id=$1 AND kind=$2",
        [this.account.id, "official"],
        conn,
      );
      if (!c) throw new AppError("AUTH_EXPIRED", "请先配置官方接口连接", 409);
      if (c.token_secret && new Date(c.token_expires_at).getTime() > Date.now())
        return unseal<string>(c.token_secret, `${this.account.id}:token`);
      const { appSecret } = unseal<{ appSecret: string }>(
        c.secret,
        `${this.account.id}:official`,
      );
      const raw = await safeFetch(
        "https://api.weixin.qq.com/cgi-bin/stable_token",
        "wechat",
        {
          method: "POST",
          body: JSON.stringify({
            grant_type: "client_credential",
            appid: this.account.app_id,
            secret: appSecret,
            force_refresh: false,
          }),
        },
      );
      const data = JSON.parse(raw.body.toString());
      if (data.errcode) throw wechatError(data.errcode);
      if (typeof data.access_token !== "string")
        throw new AppError("SOURCE_SCHEMA_CHANGED", "微信未返回有效凭据", 502);
      await conn.query(
        "UPDATE connections SET token_secret=$2,token_expires_at=$3,status=$4,last_error=NULL,last_checked_at=now() WHERE account_id=$1 AND kind=$5",
        [
          this.account.id,
          seal(data.access_token, `${this.account.id}:token`),
          new Date(
            Date.now() + Math.max(60, Number(data.expires_in) - 300) * 1000,
          ),
          "connected",
          "official",
        ],
      );
      return data.access_token as string;
    });
  }
  async request(path: string, body: any, refresh = true): Promise<any> {
    const token = await this.token();
    const r = await safeFetch(
      `https://api.weixin.qq.com/cgi-bin/${path}?access_token=${encodeURIComponent(token)}`,
      "wechat",
      { method: "POST", body: JSON.stringify(body) },
    );
    let data;
    try {
      data = JSON.parse(r.body.toString());
    } catch {
      throw new AppError(
        "SOURCE_SCHEMA_CHANGED",
        "微信返回了非 JSON 响应",
        502,
      );
    }
    if (data.errcode) {
      if (refresh && [40001, 40014, 42001].includes(data.errcode)) {
        await db.query(
          "UPDATE connections SET token_expires_at=NULL WHERE account_id=$1 AND kind=$2",
          [this.account.id, "official"],
        );
        return this.request(path, body, false);
      }
      throw wechatError(data.errcode);
    }
    return data;
  }
  async probe() {
    await this.request("freepublish/batchget", {
      offset: 0,
      count: 1,
      no_content: 0,
    });
  }
  async list(cursor = "0"): Promise<SourcePage> {
    const offset = Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new AppError("INVALID_CURSOR", "分页位置无效");
    const result = flattenOfficial(
      await this.request("freepublish/batchget", {
        offset,
        count: 20,
        no_content: 0,
      }),
    );
    if (result.messageCount === 0 && offset < (result.totalMessages ?? 0))
      throw new AppError(
        "LIST_INCOMPLETE",
        "列表提前结束，无法确认完整性",
        502,
      );
    result.ended = offset + result.messageCount >= (result.totalMessages ?? 0);
    result.cursor = result.ended ? null : String(offset + result.messageCount);
    return result;
  }
}
export async function browserCall<T = any>(
  path: string,
  body?: any,
): Promise<T> {
  const response = await fetch(`${config.browserUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${config.browserToken}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(path === "/scan" ? 600000 : 60000),
  });
  const data = (await response.json()) as any;
  if (!response.ok)
    throw new AppError(
      data.code || "BROWSER_ERROR",
      data.message || "服务器浏览器暂不可用",
      response.status,
      response.status >= 500 && data.code !== "SOURCE_SCHEMA_CHANGED",
    );
  return data;
}
export class BackendBrowserAdapter implements SourceAdapter {
  constructor(
    public account: Row,
    public scanId?: string,
    public check?: () => Promise<void>,
  ) {}
  async state() {
    const c = await one(
      "SELECT secret FROM connections WHERE account_id=$1 AND kind=$2",
      [this.account.id, "browser"],
    );
    if (!c) throw new AppError("AUTH_EXPIRED", "请扫码连接公众号后台", 409);
    return unseal<any>(c.secret, `${this.account.id}:browser`);
  }
  async probe() {
    await browserCall("/probe", {
      account: this.account,
      state: await this.state(),
    });
  }
  async list(): Promise<SourcePage> {
    return transaction(async (conn) => {
      await conn.query("SELECT pg_advisory_xact_lock(40003)");
      await this.check?.();
      return browserCall("/scan", {
        scanId: this.scanId,
        account: {
          id: this.account.id,
          original_id: this.account.original_id,
          app_id: this.account.app_id,
        },
        state: await this.state(),
      });
    });
  }
}
export class ArticleUrlAdapter implements SourceAdapter {
  constructor(public urls: string[]) {}
  async probe() {
    this.urls.forEach((x) => canonicalArticle(x));
  }
  async list(): Promise<SourcePage> {
    return {
      items: this.urls.map((url) => {
        const c = canonicalArticle(url);
        return { ...c, title: "待获取标题", source: "url", sourceId: c.key };
      }),
      cursor: null,
      ended: true,
      messageCount: this.urls.length,
      evidence: "manual_urls",
    };
  }
}
