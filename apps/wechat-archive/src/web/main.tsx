import React, {
  useState,
  useRef,
  useEffect,
  createContext,
  useContext,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Archive,
  BookOpen,
  Search,
  ArrowUpRight,
  Download,
  Plus,
  RefreshCw,
  Check,
  AlertTriangle,
  Clock,
  ChevronLeft,
  ChevronRight,
  X,
  Settings,
  Users,
  ListTodo,
  LogOut,
  FolderOpen,
  SlidersHorizontal,
  Link,
  QrCode,
  ShieldCheck,
  Menu,
  FileText,
  CheckCircle2,
} from "lucide-react";
import {
  stateLabels,
  coverageLabels,
  type JobState,
  type Coverage,
} from "../shared/types";
import "./style.css";
type Row = Record<string, any>;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const apiUrl = (path: string) => `${basePath}/api/v1${path}`;
function ToolsLink() {
  return basePath ? (
    <a className="tools-link" href="/">
      <ChevronLeft size={16} aria-hidden="true" />
      所有工具
    </a>
  ) : null;
}
let csrf = "";
async function api(path: string, body?: any, method?: string): Promise<any> {
  const r = await fetch(apiUrl(path), {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      "x-csrf-token": csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) {
    if (r.status === 401 && path !== "/auth/login")
      queryClient.setQueryData(["me"], null);
    throw new Error(data.error?.message ?? "服务暂不可用");
  }
  if (data.csrf) csrf = data.csrf;
  if (path === "/auth/logout") queryClient.clear();
  return data;
}
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});
const Feedback = createContext<
  (fn: () => Promise<any>, message?: string) => Promise<boolean>
>(async () => false);
const useAction = () => useContext(Feedback);
const date = (v: any) =>
  v
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(v))
    : "日期未知";
const datetime = (v: any) =>
  v
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(v))
    : "—";
const size = (v: number) =>
  v >= 1024 ** 3
    ? `${(v / 1024 ** 3).toFixed(1)} GB`
    : `${(v / 1024 ** 2).toFixed(1)} MB`;
function Status({ value, kind = "job" }: { value: string; kind?: string }) {
  const label =
    kind === "coverage"
      ? coverageLabels[value as Coverage]
      : kind === "resource"
        ? (
            {
              complete: "图片齐全",
              missing: "图片缺失",
              pending: "待归档",
            } as Row
          )[value]
        : stateLabels[value as JobState];
  const ok = [
    "complete",
    "verified",
    "succeeded",
    "connected",
    "ready",
  ].includes(value);
  const warn = [
    "missing",
    "has_gaps",
    "failed",
    "partial",
    "waiting_auth",
    "error",
    "cooldown",
  ].includes(value);
  return (
    <span className={`status ${ok ? "ok" : warn ? "warn" : ""}`}>
      {ok ? (
        <CheckCircle2 size={12} />
      ) : warn ? (
        <AlertTriangle size={12} />
      ) : (
        <Clock size={12} />
      )}{" "}
      {label ??
        (
          {
            connected: "已连接",
            unknown: "待检测",
            error: "需要处理",
            ready: "可下载",
            expired: "已过期",
          } as Row
        )[value] ??
        value}
    </span>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current
      ?.querySelector<HTMLElement>("button,input,select,textarea")
      ?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const focusable = [
          ...dialog.current!.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
          ),
        ].filter((el) => el.offsetParent !== null);
        const first = focusable[0],
          last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label="关闭">
            <X size={19} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <FolderOpen size={40} strokeWidth={1.2} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function Field({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...props} />
    </label>
  );
}
function LoadingError({ query }: { query: any }) {
  return query.isLoading ? (
    <p className="muted padded">正在读取…</p>
  ) : query.error ? (
    <p role="alert" className="error padded">
      {query.error.message}{" "}
      <button onClick={() => query.refetch()}>重新加载</button>
    </p>
  ) : null;
}
function Submit({
  children = "保存",
  pending = false,
}: {
  children?: ReactNode;
  pending?: boolean;
}) {
  return (
    <button className="primary" type="submit" disabled={pending}>
      {pending ? "处理中…" : children}
    </button>
  );
}
function Form({
  onSubmit,
  children,
}: {
  onSubmit: (data: Row) => Promise<any>;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  return (
    <form
      onSubmit={async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (pending) return;
        const d = Object.fromEntries(new FormData(e.currentTarget));
        setPending(true);
        try {
          await onSubmit(d);
        } finally {
          setPending(false);
        }
      }}
    >
      <fieldset disabled={pending}>{children}</fieldset>
    </form>
  );
}
function Login({ required }: { required: boolean }) {
  const action = useAction();
  return (
    <main className="auth">
      <div className="auth-story">
        <div className="brand">
          <Archive size={25} />
          <b>文藏</b>
          <span>WECHAT ARCHIVE</span>
        </div>
        <div>
          <span className="eyebrow">你的内容，妥善留存</span>
          <h1>
            让每一篇文章，
            <br />
            都有迹可循。
          </h1>
          <p>
            集中整理公众号的内容与图片。
            <br />
            随时查阅，完整带走。
          </p>
        </div>
        <small>私有部署 · 多账号管理 · Markdown 归档</small>
      </div>
      <section className="auth-form">
        <ToolsLink />
        <div className="eyebrow">团队资料库</div>
        <h2>{required ? "创建管理员" : "欢迎回来"}</h2>
        <p className="muted">
          {required
            ? "使用部署时生成的一次性安装凭证开始。"
            : "登录后继续管理你的公众号内容。"}
        </p>
        <Form
          onSubmit={(d) =>
            action(() => api(required ? "/bootstrap" : "/auth/login", d), "")
          }
        >
          {required && (
            <>
              <Field
                label="一次性安装凭证"
                name="token"
                type="password"
                required
                autoComplete="off"
              />
              <Field label="姓名" name="displayName" required />
            </>
          )}
          <Field
            label="用户名"
            name="username"
            required
            autoComplete="username"
          />
          <Field
            label="密码"
            name="password"
            type="password"
            required
            minLength={required ? 12 : undefined}
            autoComplete={required ? "new-password" : "current-password"}
          />
          {!required && (
            <Field
              label="验证器验证码或恢复码（已启用时填写）"
              name="code"
              autoComplete="one-time-code"
            />
          )}
          <Submit>{required ? "创建并继续" : "登录资料库"}</Submit>
        </Form>
        <div className="private-note">
          <ShieldCheck size={16} />
          仅受邀成员可访问，未开放公开注册
        </div>
      </section>
    </main>
  );
}
function SecuritySetup({ user, onDone }: { user: Row; onDone: () => void }) {
  const action = useAction();
  const [setup, setSetup] = useState<Row | null>(null),
    [codes, setCodes] = useState<string[]>([]);
  return (
    <main className="setup">
      <ToolsLink />
      <div className="brand">
        <Archive />
        <b>文藏</b>
      </div>
      <h1>保护你的资料库</h1>
      <p className="muted">
        {user.must_change_password
          ? "首次登录请修改临时密码。"
          : "管理员需要设置验证器才能继续。"}
      </p>
      {user.must_change_password ? (
        <Form
          onSubmit={(d) => action(() => api("/auth/password", d), "密码已更新")}
        >
          <Field label="当前密码" name="current" type="password" required />
          <Field
            label="新密码（至少 12 位）"
            name="password"
            type="password"
            minLength={12}
            required
          />
          <Submit />
        </Form>
      ) : codes.length ? (
        <>
          <p>请保存以下一次性恢复码，关闭后不再显示。</p>
          <pre>{codes.join("\n")}</pre>
          <button className="primary" onClick={onDone}>
            已保存，进入资料库
          </button>
        </>
      ) : (
        <>
          {!setup ? (
            <button
              className="primary"
              onClick={() =>
                action(
                  async () => setSetup(await api("/auth/totp/setup", {})),
                  "",
                )
              }
            >
              设置验证器
            </button>
          ) : (
            <>
              <img className="totp" src={setup.qr} alt="验证器设置二维码" />
              <p>用验证器扫描，或手动输入：</p>
              <code>{setup.secret}</code>
              <Form
                onSubmit={(d) =>
                  action(async () => {
                    const r = await api("/auth/totp/verify", d);
                    setCodes(r.recoveryCodes);
                  }, "")
                }
              >
                <Field
                  label="六位验证码"
                  name="code"
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
                <Submit>验证并生成恢复码</Submit>
              </Form>
            </>
          )}
        </>
      )}
    </main>
  );
}
function BrowserLogin({
  account,
  onClose,
}: {
  account: Row;
  onClose: () => void;
}) {
  const action = useAction();
  const [session, setSession] = useState<string>(),
    [text, setText] = useState("");
  const q = useQuery({
    queryKey: ["browser", session],
    queryFn: () => api(`/browser-sessions/${session}`),
    enabled: !!session,
    refetchInterval: (q) =>
      q.state.data?.state === "connected" ? false : 3000,
  });
  const screen = useQuery({
    queryKey: ["screen", session],
    queryFn: () => api(`/browser-sessions/${session}/screen`),
    enabled: !!session && q.data?.state !== "connected",
    refetchInterval: 3000,
  });
  const close = () => {
    if (session)
      api(`/browser-sessions/${session}`, {}, "DELETE").catch(() => {});
    onClose();
  };
  return (
    <Modal title={`连接后台 · ${account.name}`} onClose={close} wide>
      <p className="muted">
        这是服务器上的微信后台登录画面。用手机微信扫码；若需要选择公众号，可直接点击画面。身份确认后交互会关闭。
      </p>
      {!session ? (
        <button
          className="primary"
          onClick={() =>
            action(
              async () =>
                setSession(
                  (await api(`/accounts/${account.id}/browser-sessions`, {}))
                    .id,
                ),
              "",
            )
          }
        >
          打开微信登录画面
        </button>
      ) : q.data?.state === "connected" ? (
        <div className="empty">
          <CheckCircle2 />
          <h3>公众号身份已确认</h3>
          <p>后台连接已加密保存，可以开始同步。</p>
          <button className="primary" onClick={close}>
            完成
          </button>
        </div>
      ) : (
        <>
          <LoadingError query={q} />
          <LoadingError query={screen} />
          {q.data?.error && <p className="notice">{q.data.error}</p>}
          {screen.data?.image ? (
            <img
              className="remote-screen"
              src={`data:image/jpeg;base64,${screen.data.image}`}
              alt="公众号后台实时登录画面，可点击操作"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                action(
                  () =>
                    api(`/browser-sessions/${session}/action`, {
                      type: "click",
                      x: ((e.clientX - r.left) / r.width) * screen.data.width,
                      y: ((e.clientY - r.top) / r.height) * screen.data.height,
                    }),
                  "",
                );
              }}
            />
          ) : (
            <p className="padded">正在加载登录画面…</p>
          )}
          <div className="inline">
            <input
              aria-label="输入到登录画面的文字"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="需要输入验证文字时填写"
            />
            <button
              onClick={() =>
                action(
                  () =>
                    api(`/browser-sessions/${session}/action`, {
                      type: "text",
                      text,
                    }),
                  "",
                )
              }
            >
              输入
            </button>
            {["Enter", "Tab", "Backspace"].map((key) => (
              <button
                key={key}
                onClick={() =>
                  action(
                    () =>
                      api(`/browser-sessions/${session}/action`, {
                        type: "key",
                        key,
                      }),
                    "",
                  )
                }
              >
                {key}
              </button>
            ))}
          </div>
          <p className="muted small">
            会话有效期 10 分钟。请确认操作的是 {account.original_id}。
          </p>
        </>
      )}
    </Modal>
  );
}
function Accounts({ accounts, user }: { accounts: Row[]; user: Row }) {
  const action = useAction();
  const [modal, setModal] = useState<string>(),
    [selected, setSelected] = useState<Row>();
  return (
    <>
      <div className="section-title">
        <div>
          <h1>公众号管理</h1>
          <p>独立连接每一个账号，持续积累内容资产。</p>
        </div>
        {user.role === "admin" && (
          <button
            className="primary"
            onClick={() => {
              setSelected(undefined);
              setModal("create");
            }}
          >
            <Plus size={16} />
            添加公众号
          </button>
        )}
      </div>
      {!accounts.length ? (
        <Empty title="从第一个公众号开始">
          添加账号后，可配置官方接口或通过手机微信扫码连接后台。
        </Empty>
      ) : (
        <div className="accounts-grid">
          {accounts.map((a) => (
            <article className="account-card" key={a.id}>
              <div className="account-top">
                <span className="account-avatar">{a.name.slice(0, 1)}</span>
                <div>
                  <h3>{a.name}</h3>
                  <code>{a.original_id}</code>
                </div>
                <b className="count">
                  {a.article_count}
                  <small>篇文章</small>
                </b>
              </div>
              <div className="account-facts">
                <div>
                  <span>历史覆盖</span>
                  <Status value={a.coverage} kind="coverage" />
                </div>
                <div>
                  <span>官方接口</span>
                  {a.connections.official ? (
                    <Status value={a.connections.official.status} />
                  ) : (
                    <span className="muted">未配置</span>
                  )}
                </div>
                <div>
                  <span>公众号后台</span>
                  {a.connections.browser ? (
                    <Status value={a.connections.browser.status} />
                  ) : (
                    <span className="muted">未连接</span>
                  )}
                </div>
                <div>
                  <span>自动同步</span>
                  <span>
                    {a.auto_sync
                      ? `每日 ${String(a.sync_hour).padStart(2, "0")}:${String(a.sync_minute).padStart(2, "0")}`
                      : "已关闭"}
                  </span>
                </div>
              </div>
              {Object.entries(a.connections).map(
                ([k, c]: any) =>
                  c.error && (
                    <p className="notice small" key={k}>
                      {c.error}
                    </p>
                  ),
              )}
              <div className="card-actions">
                <button
                  className="primary"
                  onClick={() =>
                    action(
                      () =>
                        api(`/accounts/${a.id}/sync-jobs`, {
                          mode: a.last_synced_at ? "incremental" : "full",
                        }),
                      "同步任务已创建",
                    )
                  }
                >
                  <RefreshCw size={14} />
                  同步文章
                </button>
                <button
                  onClick={() => {
                    setSelected(a);
                    setModal("browser");
                  }}
                >
                  <QrCode size={15} />
                  扫码连接
                </button>
                <button
                  className="icon"
                  aria-label={`管理 ${a.name}`}
                  onClick={() => {
                    setSelected(a);
                    setModal("manage");
                  }}
                >
                  <Settings size={16} />
                </button>
              </div>
              <small className="muted">
                上次同步 {datetime(a.last_synced_at)}
              </small>
            </article>
          ))}
        </div>
      )}
      {modal === "browser" && selected && (
        <BrowserLogin account={selected} onClose={() => setModal(undefined)} />
      )}
      {modal === "create" && (
        <Modal title="添加公众号" onClose={() => setModal(undefined)}>
          <p className="muted small">
            原始 ID 在公众号后台「设置与开发 →
            账号详情」查看，用于确认扫码账号身份。
          </p>
          <Form
            onSubmit={(d) =>
              action(async () => {
                await api("/accounts", {
                  ...d,
                  appId: d.appId || undefined,
                  appSecret: d.appSecret || undefined,
                });
                setModal(undefined);
              }, "公众号已添加")
            }
          >
            <Field label="公众号名称" name="name" required maxLength={80} />
            <Field
              label="原始 ID"
              name="originalId"
              placeholder="gh_…"
              pattern="gh_[a-zA-Z0-9]+"
              required
            />
            <Field label="AppID（可稍后配置）" name="appId" placeholder="wx…" />
            <Field
              label="AppSecret（可稍后配置）"
              name="appSecret"
              type="password"
              autoComplete="off"
            />
            <Submit>添加公众号</Submit>
          </Form>
        </Modal>
      )}
      {modal === "manage" && selected && (
        <Modal
          title={`管理 · ${selected.name}`}
          onClose={() => setModal(undefined)}
        >
          <button
            onClick={() =>
              action(
                () =>
                  api(`/accounts/${selected.id}/sync-jobs`, {
                    mode: "reconcile",
                  }),
                "历史核对任务已创建",
              )
            }
          >
            重新核对全部历史
          </button>
          {user.role === "admin" && (
            <>
              <hr />
              <Form
                onSubmit={(d) =>
                  action(
                    () =>
                      api(
                        `/accounts/${selected.id}`,
                        {
                          name: d.name,
                          autoSync: d.autoSync === "on",
                          syncHour: Number(d.time.split(":")[0]),
                          syncMinute: Number(d.time.split(":")[1]),
                        },
                        "PATCH",
                      ),
                    "同步设置已保存",
                  )
                }
              >
                <Field
                  label="名称"
                  name="name"
                  defaultValue={selected.name}
                  required
                />
                <label className="check">
                  <input
                    name="autoSync"
                    type="checkbox"
                    defaultChecked={selected.auto_sync}
                  />
                  每日自动同步（北京时间）
                </label>
                <Field
                  label="开始时间"
                  name="time"
                  type="time"
                  defaultValue={`${String(selected.sync_hour).padStart(2, "0")}:${String(selected.sync_minute).padStart(2, "0")}`}
                  required
                />
                <Submit />
              </Form>
              <hr />
              <Form
                onSubmit={(d) =>
                  action(
                    () => api(`/accounts/${selected.id}/connections`, d, "PUT"),
                    "官方凭据已更新",
                  )
                }
              >
                <Field
                  label="AppID"
                  name="appId"
                  defaultValue={selected.app_id ?? ""}
                  required
                />
                <Field
                  label="新的 AppSecret"
                  name="appSecret"
                  type="password"
                  autoComplete="off"
                  required
                  minLength={16}
                />
                <Submit>保存官方连接</Submit>
              </Form>
              <div className="inline spaced">
                <button
                  onClick={() =>
                    action(
                      () => api(`/accounts/${selected.id}/test-connection`, {}),
                      "官方接口连接正常",
                    )
                  }
                >
                  测试官方接口
                </button>
                <button
                  className="danger"
                  onClick={() =>
                    action(
                      () =>
                        api(
                          `/accounts/${selected.id}/connections/browser`,
                          {},
                          "DELETE",
                        ),
                      "后台连接已移除，存档保留",
                    )
                  }
                >
                  断开后台连接
                </button>
              </div>
            </>
          )}
          <hr />
          <details>
            <summary>最近的清单核对报告</summary>
            <pre>{JSON.stringify(selected.coverage_report, null, 2)}</pre>
          </details>
        </Modal>
      )}
    </>
  );
}
function ArticlePreview({ id, onClose }: { id: string; onClose: () => void }) {
  const action = useAction();
  const [version, setVersion] = useState("");
  const q = useQuery({
    queryKey: ["article", id, version],
    queryFn: () =>
      api(`/articles/${id}${version ? `?version=${version}` : ""}`),
  });
  const a = q.data;
  return (
    <aside className="preview">
      <div className="preview-head">
        <span>
          <FileText size={16} />
          文章预览
        </span>
        <button className="icon" onClick={onClose} aria-label="关闭预览">
          <X size={18} />
        </button>
      </div>
      <LoadingError query={q} />
      {a && (
        <>
          <div className="preview-meta">
            <div className="eyebrow">
              {date(a.published_at)} · {a.author || "作者未提供"}
            </div>
            <h2>{a.title}</h2>
            <Status value={a.resource_state} kind="resource" />
            <a href={a.source_url} target="_blank" rel="noreferrer">
              查看微信原文 <ArrowUpRight size={13} />
            </a>
            <label className="field">
              <span>历史版本</span>
              <select
                value={version}
                onChange={(e) => setVersion(e.target.value)}
              >
                <option value="">当前版本</option>
                {a.versions.map((v: Row) => (
                  <option key={v.id} value={v.id}>
                    {datetime(v.archived_at)} · {v.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            <Form
              onSubmit={(d) =>
                action(
                  () =>
                    api(
                      `/articles/${id}/tags`,
                      {
                        tags: d.tags
                          .split(/[，,]/)
                          .map((x: string) => x.trim())
                          .filter(Boolean),
                      },
                      "PATCH",
                    ),
                  "标签已更新",
                )
              }
            >
              <div className="inline">
                <input
                  aria-label="标签，用逗号分隔"
                  name="tags"
                  key={a.tags.join(",")}
                  defaultValue={a.tags.join(", ")}
                  placeholder="添加标签，用逗号分隔"
                />
                <button type="submit">保存标签</button>
              </div>
            </Form>
            <div className="inline spaced">
              <button
                onClick={() =>
                  action(
                    () => api(`/articles/${id}/repair`, { refetch: false }),
                    "图片修复已排队",
                  )
                }
              >
                重试缺失图片
              </button>
              <button
                onClick={() =>
                  action(
                    () => api(`/articles/${id}/repair`, { refetch: true }),
                    "重新获取已排队",
                  )
                }
              >
                重新获取正文
              </button>
            </div>
            {a.source_state !== "available" && (
              <p className="notice">
                原文状态：{a.source_state}，已保留现有存档。
              </p>
            )}
            {a.images
              .filter((i: Row) => i.state !== "complete")
              .map((i: Row) => (
                <p className="notice small" key={i.source_url}>
                  {i.error || "图片待下载"}
                </p>
              ))}
          </div>
          {a.version ? (
            <div
              className="article-body"
              dangerouslySetInnerHTML={{ __html: a.version.preview_html }}
            />
          ) : (
            <Empty title="正文尚未归档">
              可重新获取正文，或在任务中心查看具体原因。
            </Empty>
          )}
        </>
      )}
    </aside>
  );
}
function Library({
  accounts,
  accountId,
  onAccount,
  openJobs,
}: {
  accounts: Row[];
  accountId: string;
  onAccount: (id: string) => void;
  openJobs: () => void;
}) {
  const action = useAction();
  const [search, setSearch] = useState(""),
    [qtext, setQtext] = useState(""),
    [page, setPage] = useState(1),
    [state, setState] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [tag, setTag] = useState(""),
    [filters, setFilters] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [preview, setPreview] = useState<string>(),
    [importing, setImporting] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      setQtext(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [accountId, state, from, to, tag]);
  const params = new URLSearchParams({
    page: String(page),
    ...(accountId ? { accountId } : {}),
    ...(qtext ? { q: qtext } : {}),
    ...(state ? { state } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(tag ? { tag } : {}),
  });
  const q = useQuery({
    queryKey: ["articles", params.toString()],
    queryFn: () => api(`/articles?${params}`),
    refetchInterval: 10000,
  });
  const summary = useQuery({
    queryKey: ["overview"],
    queryFn: () => api("/overview"),
    refetchInterval: 10000,
  });
  const items = q.data?.items ?? [];
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  return (
    <>
      <div className="section-title">
        <div>
          <div className="eyebrow">内容资产 / LIBRARY</div>
          <h1>
            {accountId
              ? accounts.find((a) => a.id === accountId)?.name
              : "文章资料库"}
          </h1>
          <p>归档有序，随时查阅。每一次更新都有记录。</p>
        </div>
        <button onClick={() => setImporting(true)} disabled={!accounts.length}>
          <Link size={15} />
          补充文章链接
        </button>
      </div>
      <div className="metrics">
        <div>
          <span>已归档文章</span>
          <strong>
            {summary.data?.total ?? "—"}
            <small>篇</small>
          </strong>
        </div>
        <div>
          <span>图片齐全</span>
          <strong>
            {summary.data?.complete ?? "—"}
            <small>篇</small>
          </strong>
        </div>
        <button
          onClick={() => {
            setState("missing");
            setFilters(true);
          }}
        >
          <span>图片待补齐</span>
          <strong className={summary.data?.missing ? "amber" : ""}>
            {summary.data?.missing ?? "—"}
            <small>篇</small>
          </strong>
        </button>
        <button onClick={openJobs}>
          <span>正在进行的任务</span>
          <strong>
            {summary.data?.activeTasks ?? "—"}
            <small>个</small>
          </strong>
        </button>
      </div>
      <div className="library-split">
        <section className="library">
          <div className="toolbar">
            <label className="search">
              <Search size={17} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索标题或正文…"
                aria-label="搜索文章"
              />
              {search && (
                <button
                  className="icon"
                  onClick={() => setSearch("")}
                  aria-label="清除搜索"
                >
                  <X size={14} />
                </button>
              )}
            </label>
            <select
              aria-label="筛选公众号"
              value={accountId}
              onChange={(e) => onAccount(e.target.value)}
            >
              <option value="">全部公众号</option>
              {accounts.map((a) => (
                <option value={a.id} key={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button
              className={filters ? "active" : ""}
              onClick={() => setFilters(!filters)}
            >
              <SlidersHorizontal size={15} />
              <span className="desktop">筛选</span>
            </button>
          </div>
          {filters && (
            <div className="filters">
              <Field
                label="开始日期"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
              <Field
                label="结束日期"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
              <Field
                label="标签"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
              />
              <label className="field">
                <span>图片状态</span>
                <select
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                >
                  <option value="">全部状态</option>
                  <option value="complete">图片齐全</option>
                  <option value="missing">图片缺失</option>
                  <option value="pending">待归档</option>
                </select>
              </label>
            </div>
          )}
          <div className="selection-bar">
            <label className="check">
              <input
                type="checkbox"
                aria-label="选择本页文章"
                checked={
                  items.length > 0 &&
                  items.every((a: Row) => selected.has(a.id))
                }
                onChange={(e) =>
                  setSelected((s) => {
                    const n = new Set(s);
                    items.forEach((a: Row) =>
                      e.target.checked ? n.add(a.id) : n.delete(a.id),
                    );
                    return n;
                  })
                }
              />{" "}
              {selected.size
                ? `已选 ${selected.size} 篇`
                : `共 ${q.data?.total ?? 0} 篇文章`}
            </label>
            <div className="inline">
              <button
                className="text-button"
                disabled={!q.data?.total || q.data.total > 1000}
                onClick={() =>
                  action(async () => {
                    const ids = new Set<string>();
                    for (let p = 1; p <= Math.ceil(q.data.total / 30); p++) {
                      params.set("page", String(p));
                      const r = await api(`/articles?${params}`);
                      r.items.forEach((a: Row) => ids.add(a.id));
                    }
                    setSelected(ids);
                  }, "已选择筛选结果")
                }
              >
                选择全部结果
              </button>
              <button
                className="primary"
                disabled={!selected.size}
                onClick={() =>
                  action(async () => {
                    await api("/exports", { articleIds: [...selected] });
                    setSelected(new Set());
                  }, "导出已开始，请在导出中心下载")
                }
              >
                <Download size={14} />
                导出
              </button>
            </div>
          </div>
          <LoadingError query={q} />
          {!q.isLoading && !q.error && !items.length ? (
            <Empty
              title={
                qtext || state || tag
                  ? "没有找到匹配的文章"
                  : "这里将保存你的公众号文章"
              }
            >
              {qtext || state || tag
                ? "试试其他关键词或清除筛选条件。"
                : "在公众号管理中连接账号并开始同步，正文和图片会保存在你的服务器。"}
            </Empty>
          ) : (
            <div className="article-list">
              {items.map((a: Row) => (
                <article
                  className={`article-row ${preview === a.id ? "selected" : ""}`}
                  key={a.id}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(a.id)}
                    onChange={() => toggle(a.id)}
                    aria-label={`选择 ${a.title}`}
                  />
                  <button
                    className="article-main"
                    onClick={() => setPreview(a.id)}
                  >
                    <div className="article-kicker">
                      <span>{a.account_name}</span>
                      <time>{date(a.published_at)}</time>
                    </div>
                    <h3>{a.title}</h3>
                    <p>{a.excerpt || "正文尚未获取"}</p>
                    <div className="article-tags">
                      {a.tags.map((t: string) => (
                        <span key={t}>{t}</span>
                      ))}
                      <Status kind="coverage" value={a.coverage} />
                      <Status kind="resource" value={a.resource_state} />
                    </div>
                  </button>
                  <ChevronRight className="row-arrow" size={17} />
                </article>
              ))}
            </div>
          )}
          <div className="pagination">
            <span>每页 30 篇</span>
            <div className="inline">
              <button
                className="icon"
                aria-label="上一页"
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <span>
                {page} / {Math.max(1, Math.ceil((q.data?.total ?? 0) / 30))}
              </span>
              <button
                className="icon"
                aria-label="下一页"
                disabled={page * 30 >= (q.data?.total ?? 0)}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </section>
        {preview && (
          <ArticlePreview
            key={preview}
            id={preview}
            onClose={() => setPreview(undefined)}
          />
        )}
      </div>
      {importing && (
        <Modal title="补充文章链接" onClose={() => setImporting(false)}>
          <p className="muted">
            仅导入属于已连接公众号的文章。每行一条微信文章链接，最多 1,000 条。
          </p>
          <Form
            onSubmit={(d) =>
              action(async () => {
                await api("/imports", {
                  accountId: d.accountId,
                  urls: d.urls.split(/\s+/).filter(Boolean),
                });
                setImporting(false);
              }, "链接导入任务已创建")
            }
          >
            <label className="field">
              <span>所属公众号</span>
              <select
                name="accountId"
                defaultValue={accountId || accounts[0]?.id}
              >
                {accounts.map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>文章链接</span>
              <textarea
                name="urls"
                rows={7}
                required
                placeholder="https://mp.weixin.qq.com/s/…"
              />
            </label>
            <Submit>开始导入</Submit>
          </Form>
        </Modal>
      )}
    </>
  );
}
function Jobs() {
  const action = useAction();
  const [detail, setDetail] = useState<string>();
  const q = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api("/jobs"),
    refetchInterval: 3000,
  });
  const d = useQuery({
    queryKey: ["job", detail],
    queryFn: () => api(`/jobs/${detail}`),
    enabled: !!detail,
    refetchInterval: 3000,
  });
  return (
    <>
      <div className="section-title">
        <div>
          <h1>任务中心</h1>
          <p>任务在服务器持续执行，关闭页面不会中断。</p>
        </div>
        <span className="live-dot">每 3 秒更新</span>
      </div>
      <LoadingError query={q} />
      {!q.data?.items.length ? (
        <Empty title="暂无任务">同步、图片修复和导出任务都会显示在这里。</Empty>
      ) : (
        <div className="tasks">
          {q.data.items.map((j: Row) => (
            <article className="task-card" key={j.id}>
              <div className="task-title">
                <div>
                  <span className="eyebrow">
                    {
                      (
                        {
                          sync: "文章同步",
                          import: "链接导入",
                          repair: "归档修复",
                          export: "导出打包",
                        } as Row
                      )[j.kind]
                    }
                  </span>
                  <h3>{j.account_name || "文章导出"}</h3>
                </div>
                <Status value={j.state} />
              </div>
              <div className="task-progress">
                <span>{j.phase}</span>
                <b>
                  {j.processed} / {j.discovered} <small>篇</small>
                </b>
              </div>
              <progress
                value={j.processed + j.failed}
                max={Math.max(j.discovered, 1)}
              />
              {j.error && <p className="notice">{j.error}</p>}
              {j.next_run_at && j.state === "cooldown" && (
                <p className="small muted">
                  下次尝试：{datetime(j.next_run_at)}
                </p>
              )}
              <div className="card-actions">
                <small className="muted">
                  {datetime(j.created_at)} · {j.failed} 篇失败
                </small>
                <button className="text-button" onClick={() => setDetail(j.id)}>
                  查看报告
                </button>
                {["queued", "running", "cooldown"].includes(j.state) && (
                  <button
                    onClick={() =>
                      action(
                        () => api(`/jobs/${j.id}/actions`, { action: "pause" }),
                        "已请求暂停",
                      )
                    }
                  >
                    暂停
                  </button>
                )}
                {[
                  "paused",
                  "waiting_auth",
                  "cooldown",
                  "failed",
                  "partial",
                ].includes(j.state) && (
                  <button
                    onClick={() =>
                      action(
                        () =>
                          api(`/jobs/${j.id}/actions`, { action: "resume" }),
                        "任务已重新排队",
                      )
                    }
                  >
                    继续 / 重试
                  </button>
                )}
                {!["succeeded", "cancelled", "failed", "partial"].includes(
                  j.state,
                ) && (
                  <button
                    className="danger text-button"
                    onClick={() =>
                      action(
                        () =>
                          api(`/jobs/${j.id}/actions`, { action: "cancel" }),
                        "已取消，保留完成的存档",
                      )
                    }
                  >
                    取消
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {detail && (
        <Modal title="任务报告" onClose={() => setDetail(undefined)} wide>
          <LoadingError query={d} />
          {d.data && (
            <>
              <p>
                发现 {d.data.discovered} 篇，成功 {d.data.processed} 篇，失败{" "}
                {d.data.failed} 篇。
              </p>
              <pre>{JSON.stringify(d.data.report, null, 2)}</pre>
              {d.data.errors.map((e: Row) => (
                <p className="notice" key={e.item_key}>
                  {e.item_key}：{e.error}
                </p>
              ))}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
function Exports() {
  const q = useQuery({
    queryKey: ["exports"],
    queryFn: () => api("/exports"),
    refetchInterval: 3000,
  });
  return (
    <>
      <div className="section-title">
        <div>
          <h1>导出中心</h1>
          <p>Markdown、图片与完整性清单，一起带走。下载包保留 7 天。</p>
        </div>
      </div>
      <LoadingError query={q} />
      {!q.data?.items.length ? (
        <Empty title="还没有导出包">
          在文章资料库中选择文章，点击导出即可生成下载包。
        </Empty>
      ) : (
        <div className="exports">
          {q.data.items.map((e: Row) => (
            <article className="export-row" key={e.id}>
              <div className="file-icon">
                <Archive size={24} />
              </div>
              <div className="grow">
                <h3>公众号归档 · {date(e.created_at)}</h3>
                <p className="muted small">
                  {e.item_count} 篇文章 ·{" "}
                  {e.size ? size(Number(e.size)) : "生成后显示大小"} ·{" "}
                  {e.expires_at
                    ? `保留至 ${datetime(e.expires_at)}`
                    : "后台处理中"}
                </p>
                <Status value={e.state === "ready" ? "ready" : e.job_state} />
                {e.manifest && (
                  <span className="small muted">
                    {e.manifest.complete
                      ? " 清单与资源已完整核对"
                      : " 含待核对内容或资源缺失，请查看 manifest.json"}
                  </span>
                )}
                {e.error && <p className="notice">{e.error}</p>}
              </div>
              {e.state === "ready" &&
              new Date(e.expires_at).getTime() > Date.now() ? (
                <a
                  className="button primary"
                  href={apiUrl(`/exports/${e.id}/download`)}
                >
                  <Download size={16} />
                  下载 ZIP
                </a>
              ) : (
                <span className="muted small">
                  {e.state === "expired" ? "请重新导出" : "请查看任务中心"}
                </span>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
function SettingsPage({ accounts, user }: { accounts: Row[]; user: Row }) {
  const action = useAction();
  const q = useQuery({
    queryKey: ["settings"],
    queryFn: () => api("/settings"),
    enabled: user.role === "admin",
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => api("/users"),
    enabled: user.role === "admin",
  });
  const [member, setMember] = useState<Row | null>(),
    [password, setPassword] = useState(false);
  return (
    <>
      <div className="section-title">
        <div>
          <h1>设置与成员</h1>
          <p>管理访问范围，了解资料库的运行状态。</p>
        </div>
        <button onClick={() => setPassword(true)}>修改我的密码</button>
      </div>
      {user.role === "admin" && (
        <>
          <LoadingError query={q} />
          {q.data && (
            <div className="settings-info">
              <div>
                <span>文件存储</span>
                <strong>
                  {q.data.storageDriver === "s3"
                    ? "S3 / Cloudflare R2"
                    : "服务器持久化目录"}
                </strong>
              </div>
              <div>
                <span>服务器出口 IP</span>
                <strong>
                  {q.data.egressIp || "尚未配置 WECHAT_EGRESS_IP"}
                </strong>
                <small>在微信后台手工加入白名单，不覆盖已有条目。</small>
              </div>
              <div>
                <span>磁盘剩余</span>
                <strong>
                  {q.data.diskFree ? size(q.data.diskFree) : "暂不可用"}
                </strong>
              </div>
              <div>
                <span>运行与备份</span>
                {q.data.statuses.length ? (
                  q.data.statuses.map((s: Row) => (
                    <p key={s.key}>
                      {s.key} · {datetime(s.updated_at)}
                      <small>{JSON.stringify(s.value)}</small>
                    </p>
                  ))
                ) : (
                  <strong>等待服务上报</strong>
                )}
              </div>
            </div>
          )}
          <div className="section-title small-title">
            <div>
              <h2>团队成员</h2>
              <p>运营成员只能访问被分配的公众号。</p>
            </div>
            <button onClick={() => setMember(null)}>
              <Plus size={15} />
              邀请成员
            </button>
          </div>
          <LoadingError query={users} />
          <div className="member-list">
            {users.data?.items.map((u: Row) => (
              <div key={u.id}>
                <span className="account-avatar">{u.display_name[0]}</span>
                <div className="grow">
                  <h3>
                    {u.display_name} <small>{u.username}</small>
                  </h3>
                  <span className="muted small">
                    {u.role === "admin"
                      ? "管理员 · 全部公众号"
                      : `运营成员 · ${u.account_ids.length} 个公众号`}{" "}
                    · {u.active ? "启用" : "已停用"}
                  </span>
                </div>
                {u.id !== user.id && (
                  <button onClick={() => setMember(u)}>管理权限</button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {member !== undefined && (
        <Modal
          title={member ? "成员权限" : "创建受邀成员"}
          onClose={() => setMember(undefined)}
        >
          <Form
            onSubmit={async (d) => {
              const data = {
                ...d,
                accountIds: accounts
                  .filter((a) => d[`a_${a.id}`] === "on")
                  .map((a) => a.id),
                active: d.active === "on",
              };
              await action(async () => {
                await api(
                  member ? `/users/${member.id}` : "/users",
                  data,
                  member ? "PUT" : "POST",
                );
                setMember(undefined);
              }, "成员设置已保存");
            }}
          >
            {!member ? (
              <>
                <Field label="姓名" name="displayName" required />
                <Field
                  label="用户名"
                  name="username"
                  required
                  pattern="[a-zA-Z0-9_-]{3,40}"
                />
                <Field
                  label="临时密码（至少 12 位，首次登录必须修改）"
                  name="password"
                  type="password"
                  required
                  minLength={12}
                />
              </>
            ) : (
              <label className="check">
                <input
                  type="checkbox"
                  name="active"
                  defaultChecked={member.active}
                />
                启用此成员
              </label>
            )}
            <p>可访问的公众号</p>
            {accounts.map((a) => (
              <label className="check spaced" key={a.id}>
                <input
                  type="checkbox"
                  name={`a_${a.id}`}
                  defaultChecked={member?.account_ids.includes(a.id)}
                />
                {a.name}
              </label>
            ))}
            <div className="spaced">
              <Submit />
            </div>
          </Form>
        </Modal>
      )}
      {password && (
        <Modal title="修改密码" onClose={() => setPassword(false)}>
          <Form
            onSubmit={(d) =>
              action(async () => {
                await api("/auth/password", d);
                setPassword(false);
              }, "密码已更新，其他会话已退出")
            }
          >
            <Field label="当前密码" name="current" type="password" required />
            <Field
              label="新密码（至少 12 位）"
              name="password"
              type="password"
              minLength={12}
              required
            />
            <Submit />
          </Form>
        </Modal>
      )}
    </>
  );
}
function Workspace({ user }: { user: Row }) {
  const action = useAction();
  const [page, setPage] = useState("library"),
    [accountId, setAccountId] = useState(""),
    [mobile, setMobile] = useState(false);
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api("/accounts"),
    refetchInterval: 10000,
  });
  const navigate = (p: string) => {
    setPage(p);
    setMobile(false);
  };
  const nav = [
    ["library", "文章资料库", BookOpen],
    ["accounts", "公众号管理", Users],
    ["jobs", "任务中心", ListTodo],
    ["exports", "导出中心", Download],
    ["settings", "设置与成员", Settings],
  ] as const;
  return (
    <div className="workspace">
      {mobile && (
        <div className="drawer-backdrop" onClick={() => setMobile(false)} />
      )}
      <aside className={`sidebar ${mobile ? "open" : ""}`}>
        <ToolsLink />
        <div className="brand">
          <Archive size={26} />
          <b>文藏</b>
          <span>ARCHIVE</span>
        </div>
        <div className="workspace-label">
          团队工作空间 <ShieldCheck size={13} />
        </div>
        <nav>
          {nav.map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => navigate(id)}
              className={page === id ? "current" : ""}
            >
              <Icon size={18} />
              {label}
              {page === id && <span className="nav-mark" />}
            </button>
          ))}
        </nav>
        <div className="account-nav">
          <div className="nav-label">
            公众号 <span>{accounts.data?.items.length ?? 0}</span>
          </div>
          <button
            className={page === "library" && !accountId ? "chosen" : ""}
            onClick={() => {
              setAccountId("");
              navigate("library");
            }}
          >
            <span className="all-dot" />
            全部文章
          </button>
          {accounts.data?.items.map((a: Row) => (
            <button
              key={a.id}
              className={
                page === "library" && accountId === a.id ? "chosen" : ""
              }
              onClick={() => {
                setAccountId(a.id);
                navigate("library");
              }}
            >
              <span className="account-dot">{a.name[0]}</span>
              <span className="ellipsis">{a.name}</span>
              <small>{a.article_count}</small>
            </button>
          ))}
        </div>
        <div className="sidebar-foot">
          <ShieldCheck size={18} />
          <div>
            私有资料库<small>内容与凭据由你的服务器保存</small>
          </div>
        </div>
        <div className="profile">
          <span className="user-avatar">{user.display_name[0]}</span>
          <div>
            <b>{user.display_name}</b>
            <small>{user.role === "admin" ? "管理员" : "运营成员"}</small>
          </div>
          <button
            className="icon"
            aria-label="退出登录"
            onClick={() => action(() => api("/auth/logout", {}), "已退出登录")}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <button
              className="icon mobile-menu"
              onClick={() => setMobile(!mobile)}
              aria-label="打开导航"
            >
              <Menu size={20} />
            </button>
            <span>工作空间</span>
            <span className="slash">/</span>
            <b>{nav.find((n) => n[0] === page)?.[1]}</b>
          </div>
          <div className="private">
            <span />
            私有访问 <ShieldCheck size={14} />
          </div>
        </header>
        <main className="main">
          <LoadingError query={accounts} />
          {page === "library" && (
            <Library
              accounts={accounts.data?.items ?? []}
              accountId={accountId}
              onAccount={setAccountId}
              openJobs={() => navigate("jobs")}
            />
          )}
          {page === "accounts" && (
            <Accounts accounts={accounts.data?.items ?? []} user={user} />
          )}
          {page === "jobs" && <Jobs />}
          {page === "exports" && <Exports />}
          {page === "settings" && (
            <SettingsPage accounts={accounts.data?.items ?? []} user={user} />
          )}
        </main>
        <footer>
          文藏 · 公众号在线归档 <span>时间以北京时间显示</span>
        </footer>
      </div>
    </div>
  );
}
function App() {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [recoveries, setRecoveries] = useState(false);
  const boot = useQuery({
    queryKey: ["bootstrap"],
    queryFn: () => api("/bootstrap/status"),
  });
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api("/auth/me"),
    enabled: boot.data?.required === false,
  });
  const action = async (fn: () => Promise<any>, message = "操作已完成") => {
    try {
      await fn();
      if (message) setNotice({ text: message, error: false });
      await qc.invalidateQueries({
        predicate: (q) =>
          !["screen", "browser", "me"].includes(String(q.queryKey[0])),
      });
      if (message !== "" || !me.data)
        await qc.invalidateQueries({ queryKey: ["me"] });
      return true;
    } catch (e) {
      setNotice({
        text: e instanceof Error ? e.message : "操作失败",
        error: true,
      });
      return false;
    }
  };
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(
      () => setNotice(null),
      notice.error ? 12000 : 5000,
    );
    return () => clearTimeout(timer);
  }, [notice]);
  // Keep the security screen mounted until recovery codes have been explicitly saved.
  useEffect(() => {
    if (me.data?.user.role === "admin" && !me.data.user.totp_enabled)
      setRecoveries(true);
  }, [me.data]);
  return (
    <Feedback.Provider value={action}>
      {boot.isLoading || me.isLoading ? (
        <div className="boot">
          <Archive />
          <p>正在打开资料库…</p>
        </div>
      ) : boot.error ? (
        <div className="setup">
          <h1>暂时无法连接资料库</h1>
          <LoadingError query={boot} />
        </div>
      ) : boot.data?.required || !me.data ? (
        <Login required={boot.data?.required ?? false} />
      ) : me.data.user.must_change_password ||
        (me.data.user.role === "admin" &&
          (!me.data.user.totp_enabled || recoveries)) ? (
        <SecuritySetup
          user={me.data.user}
          onDone={() => {
            setRecoveries(false);
            qc.invalidateQueries({ queryKey: ["me"] });
          }}
        />
      ) : (
        <Workspace user={me.data.user} />
      )}
      {notice && (
        <div role="alert" className={`toast ${notice.error ? "error" : ""}`}>
          {notice.error ? <AlertTriangle size={18} /> : <Check size={18} />}
          <span>{notice.text}</span>
          <button
            className="icon"
            onClick={() => setNotice(null)}
            aria-label="关闭通知"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </Feedback.Provider>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
