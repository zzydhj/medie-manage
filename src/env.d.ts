/// <reference types="astro/client" />

// Vite 资源 URL 导入(pdf.js worker 文件):?url 返回构建后的资源地址
declare module '*?url' {
  const src: string;
  export default src;
}

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

// mammoth 浏览器预打包版(UMD)无官方类型声明,补最小声明供动态 import 使用
declare module 'mammoth/mammoth.browser.js' {
  interface MammothResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  const mammoth: {
    convertToHtml(
      input: { arrayBuffer: ArrayBuffer },
      options?: Record<string, unknown>,
    ): Promise<MammothResult>;
  };
  export default mammoth;
}

// libheif-js wasm 预打包(CJS 包装,无官方类型):HEIC 转码兜底解码,动态 import 按需加载
declare module 'libheif-js/wasm-bundle' {
  export interface LibheifImage {
    get_width(): number;
    get_height(): number;
    display(imageData: ImageData, callback: (data: ImageData | null) => void): void;
  }
  export interface LibheifModule {
    HeifDecoder: new () => { decode(data: Uint8Array): LibheifImage[] };
  }
  // CJS 包装调用后在不同环境可能是模块对象或 Promise,调用处 await 统一归一
  const libheif: LibheifModule | Promise<LibheifModule>;
  export default libheif;
}
