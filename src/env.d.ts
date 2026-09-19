/// <reference types="astro/client" />

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

// Cloudflare 绑定:在 wrangler.jsonc 中声明,运行时通过 locals.runtime.env 访问
interface Env {
  DB: D1Database;
  R2: R2Bucket;
  SESSION_SECRET: string;
}

declare namespace App {
  interface Locals extends Runtime {
    // 由 src/middleware.ts 注入
    user: SessionUser | null;
    // 当前生效的公司作用域(superadmin 由请求头选择,普通用户为自身 org)
    currentOrgId: string | null;
  }
}

interface SessionUser {
  id: string;
  username: string;
  role: 'superadmin' | 'admin' | 'user';
  orgId: string | null;
}
