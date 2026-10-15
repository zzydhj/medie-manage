// 演示数据种子:为官网首页截图造一个独立的「演示公司」,只走公开 HTTP 接口,
// 不直接写库、不碰任何已有公司/素材数据。
//
// 用法(需先 npm run dev):
//   node scripts/seed-demo.mjs [--base http://localhost:4321]
//
// 幂等:账号已存在时自动改为登录;已建过的菜单/素材按名称去重,可反复运行。

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ARG_BASE = process.argv.indexOf('--base');
const BASE = ARG_BASE >= 0 ? process.argv[ARG_BASE + 1] : 'http://localhost:4321';

const DEMO = {
  orgName: '光影传媒(演示)',
  username: 'demo',
  password: 'demo123456',
};

const IMG_DIR = 'C:/Users/Jack/.qoder-cn/vibe_images';
const FILES = {
  cup: 'demo-product-01_1791897279.png',
  skincare: 'demo-product-02_1791897278.png',
  poster: 'demo-poster-03_1791897280.png',
  banner: 'demo-banner-04_1791897303.png',
  aluminum: 'demo-material-05_1791897300.png',
  packaging: 'demo-packaging-06_1791897301.png',
  lifestyle: 'demo-lifestyle-07_1791897325.png',
  swatch: 'demo-colorswatch-08_1791897324.png',
  interior: 'demo-interior-09_1791897327.png',
};

/** 菜单树 + 每个叶子下的素材(缩略图直接复用原图,演示站不追求体积) */
const TREE = [
  {
    name: '品牌视觉',
    children: [
      {
        name: '产品摄影',
        items: [
          { file: FILES.cup, title: '保温杯 · 主图' },
          { file: FILES.skincare, title: '护肤品套装 · 电商主图' },
          { file: FILES.aluminum, title: '铝型材样品 · 细节' },
          { file: FILES.packaging, title: '包装物料 · 平铺' },
        ],
      },
      {
        name: '海报与主视觉',
        items: [
          { file: FILES.poster, title: '发布会主视觉 · 竖版' },
          { file: FILES.banner, title: '官网首屏 Banner · 横版' },
        ],
      },
      {
        name: '空间与场景',
        items: [
          { file: FILES.lifestyle, title: '生活方式场景 · 咖啡桌' },
          { file: FILES.interior, title: '品牌展厅 · 空间' },
        ],
      },
    ],
  },
  {
    name: '设计规范',
    children: [{ name: '色彩与手册', items: [{ file: FILES.swatch, title: '品牌色卡 · 主色辅助色' }] }],
  },
];

let cookie = '';

async function req(pathname, { method = 'GET', body, json: jsonBody } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload = body;
  if (jsonBody !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(jsonBody);
  }
  const res = await fetch(BASE + pathname, { method, headers, body: payload });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || `${method} ${pathname} → ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 注册演示公司;不可用(已存在 / 自助注册被站点配置关闭)则回退为登录,脚本仍可反复运行 */
async function ensureAccount() {
  try {
    await req('/api/auth/register', { method: 'POST', json: DEMO });
    console.log(`✓ 已创建演示公司「${DEMO.orgName}」与管理账号 ${DEMO.username}`);
    return;
  } catch (e) {
    console.log(`· 注册不可用(${e.message}),改为登录已有演示账号`);
  }
  await req('/api/auth/login', {
    method: 'POST',
    json: { username: DEMO.username, password: DEMO.password },
  });
  console.log(`✓ 已登录演示账号 ${DEMO.username}`);
}

async function listMenus() {
  const { menus } = await req('/api/content');
  return menus ?? [];
}

async function createMenu(name, parentId) {
  const { menu } = await req('/api/menus', { method: 'POST', json: { name, parentId: parentId ?? null } });
  return menu;
}

async function upload(file, kind) {
  const buf = await readFile(path.join(IMG_DIR, file));
  const form = new FormData();
  form.set('file', new Blob([buf], { type: 'image/png' }), file.replace(/_\d+\.png$/, '.png'));
  form.set('kind', kind);
  return req('/api/upload', { method: 'POST', body: form });
}

async function createItem(menuId, main, title) {
  return req('/api/items', {
    method: 'POST',
    json: {
      menuId,
      type: main.type,
      title,
      fileKey: main.key,
      fileUrl: main.url,
      thumbKey: main.key, // 演示数据:缩略图复用原图
      thumbUrl: main.url,
      mime: main.mime,
      size: main.size,
      filename: main.filename,
    },
  });
}

async function main() {
  await ensureAccount();

  const existing = await listMenus();
  if (existing.length) {
    console.log('· 演示公司已存在菜单,跳过重复灌入(如需重建请先删除该公司)');
    return;
  }

  let count = 0;
  for (const root of TREE) {
    const rootNode = await createMenu(root.name, null);
    for (const leaf of root.children) {
      const leafNode = await createMenu(leaf.name, rootNode.id);
      for (const it of leaf.items) {
        const mainFile = await upload(it.file, 'main');
        await createItem(leafNode.id, mainFile, it.title);
        count++;
        console.log(`  + ${root.name} / ${leaf.name} / ${it.title}`);
      }
    }
  }
  console.log(`\n✓ 演示数据完成:${TREE.length} 个一级菜单、${count} 个素材`);
  console.log(`  登录 ${BASE}/login → ${DEMO.username} / ${DEMO.password}`);
}

await main();
