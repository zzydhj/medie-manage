// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
export default defineConfig({
  // 全站服务端渲染:页面按登录态/公司动态渲染,API 端点以 Workers 运行
  output: 'server',
  adapter: cloudflare({
    // 本地 `astro dev` 时启用 platform proxy,加载 wrangler 配置里的 D1 / R2 绑定(本地模拟)
    platformProxy: {
      enabled: true,
    },
  }),
  integrations: [tailwind()],
});
