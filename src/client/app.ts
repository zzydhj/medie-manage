// 客户端主逻辑:渲染菜单树与素材卡片、管理员编辑、上传到 R2、拖拽排序、公司/用户管理。
// 所有写操作通过 X-Org-Id 头声明当前公司作用域(超级管理员),普通用户由服务端强制用自身公司。
import Sortable from 'sortablejs';

// ---------------- 类型 ----------------
interface MenuNode {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  children: MenuNode[];
}
interface ItemDTO {
  id: string;
  menu_id: string;
  type: 'image' | 'video' | 'pdf' | 'word' | 'excel';
  title: string;
  file_url: string;
  thumb_url: string | null;
  filename: string | null;
  sort_order: number;
}
interface Org {
  id: string;
  name: string;
  slug: string;
}
interface Me {
  user: { id: string; username: string; role: string; orgId: string | null; gridCols: number | null };
  orgs?: Org[];
  org?: Org;
  activeOrgId: string | null;
}

// ---------------- 全局状态 ----------------
let ME: Me | null = null;
let activeOrgId: string | null = null;
let MENUS: MenuNode[] = [];
let ITEMS: ItemDTO[] = [];
let selectedMenuId: string | null = null;
let isAdmin = false;
let isSuper = false;

// 新增素材弹窗的暂存上传结果
let pendingUpload: {
  type: 'image' | 'video' | 'pdf' | 'word' | 'excel';
  fileKey: string;
  fileUrl: string;
  mime: string;
  size: number;
  filename: string;
  thumbKey: string | null;
  thumbUrl: string | null;
} | null = null;

// 素材类型元信息:标签、Font Awesome 图标、配色 class、是否可在灯箱内在线预览
type ItemType = 'image' | 'video' | 'pdf' | 'word' | 'excel';
const TYPE_META: Record<ItemType, { label: string; icon: string; cls: string; preview: boolean }> = {
  image: { label: '图片', icon: 'fa-file-image', cls: 't-image', preview: true },
  video: { label: '视频', icon: 'fa-file-video', cls: 't-video', preview: true },
  pdf: { label: 'PDF', icon: 'fa-file-pdf', cls: 't-pdf', preview: true },
  word: { label: 'Word', icon: 'fa-file-word', cls: 't-word', preview: true },
  excel: { label: 'Excel', icon: 'fa-file-excel', cls: 't-excel', preview: true },
};

// ---------------- DOM 快捷 ----------------
// 返回 any:客户端脚本中大量按 id 取具体元素类型,避免逐个泛型标注
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const $ = (sel: string): any => document.querySelector(sel);

function orgHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(extra || {}) };
  if (activeOrgId) h['X-Org-Id'] = activeOrgId;
  return h;
}

async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: orgHeaders(opts.headers as Record<string, string>),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || `请求失败(${res.status})`);
  return data as T;
}

// ---------------- 提示 ----------------
let toastTimer: number | undefined;
function toast(msg: string, isError = false) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------------- 弹窗 ----------------
function openModal(id: string) {
  $(`#${id}`)?.classList.add('open');
}
function closeModal(id: string) {
  $(`#${id}`)?.classList.remove('open');
}
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const closeId = t.getAttribute?.('data-close') || t.closest?.('[data-close]')?.getAttribute('data-close');
  if (closeId) closeModal(closeId);
});
document.querySelectorAll('.modal-mask').forEach((m) => {
  m.addEventListener('click', (e) => {
    if (e.target === m) m.classList.remove('open');
  });
});

// ---------------- 初始化 ----------------
async function init() {
  ME = await api<Me>('/api/me');
  isAdmin = ME.user.role === 'superadmin' || ME.user.role === 'admin';
  isSuper = ME.user.role === 'superadmin';
  activeOrgId = ME.activeOrgId;

  // 顶栏用户信息
  const who = $('#whoami');
  if (who) {
    const roleLabel =
      ME.user.role === 'superadmin' ? '超级管理员' : ME.user.role === 'admin' ? '管理员' : '用户';
    who.textContent = `${ME.user.username} · ${roleLabel}`;
    who.classList.remove('hidden');
  }

  // 公司切换器(仅超级管理员)
  if (isSuper && ME.orgs) {
    const sel = $('#org-switcher') as HTMLSelectElement | null;
    if (sel) {
      sel.innerHTML = ME.orgs
        .map((o) => `<option value="${o.id}" ${o.id === activeOrgId ? 'selected' : ''}>${escapeHtml(o.name)}</option>`)
        .join('');
      sel.classList.remove('hidden');
      sel.addEventListener('change', () => {
        activeOrgId = sel.value;
        selectedMenuId = null;
        loadContent();
      });
    }
    $('#btn-companies')?.classList.remove('hidden');
  }
  // 用户管理入口:超级管理员 + 公司管理员
  if (isAdmin) $('#btn-users')?.classList.remove('hidden');

  bindHeader();
  bindModals();
  initColControl();
  initLightbox();

  await loadContent();
}

function bindHeader() {
  $('#btn-logout')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  });
  $('#btn-companies')?.addEventListener('click', openOrgModal);
  $('#btn-users')?.addEventListener('click', openUserModal);

  // 移动端侧栏开合
  const sidebar = $('#sidebar');
  const overlay = $('#sidebar-overlay');
  $('#menu-toggle')?.addEventListener('click', () => {
    sidebar?.classList.toggle('open');
    overlay?.classList.toggle('open');
  });
  overlay?.addEventListener('click', () => {
    sidebar?.classList.remove('open');
    overlay?.classList.remove('open');
  });

  // 新增一级菜单
  $('#add-root-menu')?.addEventListener('click', () => openMenuModal(null, ''));
}

// ---------------- 加载内容 ----------------
async function loadContent() {
  if (!activeOrgId) {
    MENUS = [];
    ITEMS = [];
    renderSidebar();
    renderGrid();
    return;
  }
  const data = await api<{ menus: MenuNode[]; items: ItemDTO[] }>('/api/content');
  MENUS = data.menus;
  ITEMS = data.items;

  // 默认选中第一个叶子菜单
  if (!selectedMenuId || !findMenu(MENUS, selectedMenuId)) {
    selectedMenuId = firstLeafId(MENUS);
  }
  renderSidebar();
  renderGrid();
  if (isAdmin) $('#add-root-menu')?.classList.remove('hidden');
}

function findMenu(nodes: MenuNode[], id: string): MenuNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const f = findMenu(n.children, id);
    if (f) return f;
  }
  return null;
}
function firstLeafId(nodes: MenuNode[]): string | null {
  for (const n of nodes) {
    if (!n.children.length) return n.id;
    const f = firstLeafId(n.children);
    if (f) return f;
  }
  return nodes[0]?.id ?? null;
}
function menuPath(nodes: MenuNode[], id: string, trail: string[] = []): string[] {
  for (const n of nodes) {
    const next = [...trail, n.name];
    if (n.id === id) return next;
    const f = menuPath(n.children, id, next);
    if (f.length) return f;
  }
  return [];
}
function countItemsIn(menuId: string): number {
  return ITEMS.filter((i) => i.menu_id === menuId).length;
}
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

// ---------------- 渲染侧边栏 ----------------
function renderSidebar() {
  const host = $('#menu-tree');
  if (!host) return;
  host.innerHTML = renderMenuList(MENUS, '', 1);
  bindMenuTree();
}

function renderMenuList(nodes: MenuNode[], parentId: string, depth: number): string {
  const rows = nodes
    .map((n) => {
      const hasKids = n.children.length > 0;
      const isActive = n.id === selectedMenuId;
      const adminBtns = isAdmin
        ? `<button class="mini-btn" data-act="add-child" data-id="${n.id}" title="新增子菜单"><i class="fa-solid fa-plus"></i></button>
           <button class="mini-btn" data-act="edit-menu" data-id="${n.id}" title="重命名"><i class="fa-solid fa-pen"></i></button>
           <button class="mini-btn danger" data-act="del-menu" data-id="${n.id}" title="删除"><i class="fa-solid fa-trash"></i></button>`
        : '';
      const handle = isAdmin ? `<i class="fa-solid fa-grip-vertical drag-handle" title="拖拽排序"></i>` : '';
      return `
        <div class="menu-node menu-depth-${depth} ${hasKids ? '' : ''}" data-id="${n.id}">
          <div class="menu-row ${isActive ? 'active' : ''}" data-id="${n.id}">
            <span class="menu-caret">${hasKids ? '›' : ''}</span>
            ${handle}
            <span class="menu-label">${escapeHtml(n.name)}</span>
            <span class="menu-count">${countItemsIn(n.id)}</span>
            ${adminBtns}
          </div>
          ${
            hasKids
              ? `<div class="menu-children"><div class="menu-list" data-parent="${n.id}">${renderMenuList(
                  n.children,
                  n.id,
                  Math.min(depth + 1, 4),
                )}</div></div>`
              : ''
          }
        </div>`;
    })
    .join('');
  return `<div class="menu-list" data-parent="${parentId}">${rows}</div>`;
}

let menuSortables: Sortable[] = [];
function bindMenuTree() {
  // 展开/选中 + 管理员按钮
  document.querySelectorAll<HTMLElement>('.menu-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      const id = row.dataset.id!;
      if (btn) {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'add-child') openMenuModal(id, '');
        else if (act === 'edit-menu') {
          const m = findMenu(MENUS, id);
          openMenuModal(m?.parent_id ?? null, m?.name ?? '', id);
        } else if (act === 'del-menu') deleteMenu(id);
        return;
      }
      // 点击箭头切换展开;点击行选中
      const node = row.parentElement as HTMLElement;
      const caret = (e.target as HTMLElement).closest('.menu-caret');
      if (caret && node.querySelector('.menu-children')) {
        node.classList.toggle('open');
        return;
      }
      selectedMenuId = id;
      document.querySelectorAll('.menu-row.active').forEach((r) => r.classList.remove('active'));
      row.classList.add('active');
      renderGrid();
      // 移动端选中后收起侧栏
      if (window.innerWidth < 1024) {
        $('#sidebar')?.classList.remove('open');
        $('#sidebar-overlay')?.classList.remove('open');
      }
    });
  });

  // 默认展开到选中项的路径
  if (selectedMenuId) {
    const path = menuPath(MENUS, selectedMenuId);
    let nodes = MENUS;
    for (const name of path) {
      const n = nodes.find((x) => x.name === name);
      if (!n) break;
      const el = document.querySelector<HTMLElement>(`.menu-node[data-id="${n.id}"]`);
      el?.classList.add('open');
      nodes = n.children;
    }
  }

  // 拖拽排序(仅管理员)
  menuSortables.forEach((s) => s.destroy());
  menuSortables = [];
  if (isAdmin) {
    document.querySelectorAll<HTMLElement>('.menu-list').forEach((list) => {
      menuSortables.push(
        Sortable.create(list, {
          group: 'menus',
          animation: 150,
          handle: '.drag-handle',
          delay: 300,
          delayOnTouchOnly: true,
          fallbackOnBody: true,
          onEnd: async (evt) => {
            const id = evt.item.dataset.id!;
            const toList = evt.to as HTMLElement;
            const parentId = toList.dataset.parent || null;
            const newIndex = Array.from(toList.children).indexOf(evt.item);
            try {
              await api('/api/menus/reorder', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, parentId, newIndex }),
              });
              await loadContent();
            } catch (e) {
              toast((e as Error).message, true);
              await loadContent();
            }
          },
        }),
      );
    });
  }
}

// ---------------- 渲染卡片区 ----------------
function renderGrid() {
  const grid = $('#card-grid');
  const bc = $('#breadcrumb');
  if (!grid) return;

  if (!activeOrgId) {
    if (bc) bc.textContent = '';
    grid.innerHTML = `<div class="empty-hint">请先在上方选择或创建一个公司</div>`;
    return;
  }
  if (bc) {
    bc.textContent = selectedMenuId ? menuPath(MENUS, selectedMenuId).join('  ›  ') : '';
  }
  if (!selectedMenuId) {
    grid.innerHTML = `<div class="empty-hint">${
      isAdmin ? '左侧还没有菜单,点击"新增一级菜单"开始' : '暂无内容'
    }</div>`;
    return;
  }

  const items = ITEMS.filter((i) => i.menu_id === selectedMenuId).sort(
    (a, b) => a.sort_order - b.sort_order,
  );

  // 全部类型均可在灯箱内预览:图片/视频/PDF 原生渲染,Word/Excel 由客户端解析渲染
  const previewable = items.filter((it) => TYPE_META[it.type].preview);
  PREVIEW_LIST = previewable.map((it) => ({
    src: it.file_url,
    title: it.title,
    filename: it.filename || '',
    kind: it.type as PreviewItem['kind'],
  }));
  const pindexOf = new Map<string, number>();
  previewable.forEach((it, i) => pindexOf.set(it.id, i));

  const cards = items
    .map((it) => {
      const meta = TYPE_META[it.type];
      const isMedia = it.type === 'image' || it.type === 'video';
      const previewSrc =
        it.type === 'video' ? it.thumb_url || '' : it.type === 'image' ? it.file_url : '';
      const pindex = pindexOf.get(it.id);
      const adminBar = isAdmin
        ? `<div class="card-admin">
             <button class="mini-btn danger" data-act="del-item" data-id="${it.id}" title="删除"><i class="fa-solid fa-trash"></i></button>
           </div>`
        : '';
      const thumbInner = isMedia
        ? previewSrc
          ? `<img src="${previewSrc}" alt="${escapeHtml(it.title)}" loading="lazy" />`
          : `<div class="text-slate-300 text-xs">无预览</div>`
        : `<div class="doc-icon ${meta.cls}"><i class="fa-solid ${meta.icon}"></i></div>`;
      return `
        <div class="media-card" data-id="${it.id}"${
          pindex !== undefined ? ` data-pindex="${pindex}"` : ''
        }>
          <div class="media-thumb" data-preview="${it.file_url}" data-kind="${
            it.type
          }" data-title="${escapeHtml(it.title)}">
            ${thumbInner}
            <span class="type-badge ${meta.cls}">${meta.label}</span>
            ${it.type === 'video' ? `<span class="play-badge"><i class="fa-solid fa-circle-play"></i></span>` : ''}
            <button class="download-btn" data-act="download" data-url="${it.file_url}" data-name="${escapeHtml(
              it.filename || it.title,
            )}" title="下载"><i class="fa-solid fa-download"></i></button>
            ${adminBar}
          </div>
          <div class="card-title">${escapeHtml(it.title)}</div>
        </div>`;
    })
    .join('');

  const addTile = isAdmin
    ? `<div class="add-card" id="add-item-tile"><i class="fa-solid fa-plus"></i><span>添加素材</span></div>`
    : '';

  grid.innerHTML = cards + addTile + (items.length === 0 && !isAdmin ? `<div class="empty-hint">该菜单下暂无素材</div>` : '');

  bindGrid();
}

let cardSortable: Sortable | null = null;
function bindGrid() {
  // 下载
  document.querySelectorAll<HTMLElement>('[data-act="download"]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = b.dataset.url!;
      window.location.href = `${url}${url.includes('?') ? '&' : '?'}download=1`;
    });
  });
  // 删除卡片
  document.querySelectorAll<HTMLElement>('[data-act="del-item"]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('确定删除该素材?此操作不可恢复。')) return;
      try {
        await api(`/api/items/${b.dataset.id}`, { method: 'DELETE' });
        toast('已删除');
        await loadContent();
      } catch (err) {
        toast((err as Error).message, true);
      }
    });
  });
  // 预览:图片/视频/PDF 打开全屏预览并支持左右切换;Word/Excel 不支持在线预览,点击转下载
  document.querySelectorAll<HTMLElement>('.media-thumb').forEach((t) => {
    t.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-act]')) return;
      const card = t.closest('.media-card') as HTMLElement | null;
      const pindex = card?.dataset.pindex;
      if (pindex !== undefined && pindex !== '') {
        openLightboxAt(parseInt(pindex, 10));
      } else {
        const url = t.dataset.preview || '';
        if (url) {
          window.location.href = `${url}${url.includes('?') ? '&' : '?'}download=1`;
          toast('该格式不支持在线预览,已开始下载');
        }
      }
    });
  });
  // 新增素材
  $('#add-item-tile')?.addEventListener('click', () => openItemModal());

  // 卡片拖拽排序(仅管理员)
  if (cardSortable) cardSortable.destroy();
  const grid = $('#card-grid');
  if (isAdmin && grid) {
    cardSortable = Sortable.create(grid, {
      animation: 150,
      delay: 250,
      delayOnTouchOnly: true,
      filter: '.add-card, .empty-hint',
      onEnd: async (evt) => {
        const id = evt.item.dataset.id;
        if (!id || !selectedMenuId) return;
        // 计算新索引(排除 add-card 占位)
        const cards = Array.from(grid.querySelectorAll('.media-card')) as HTMLElement[];
        const newIndex = cards.indexOf(evt.item as HTMLElement);
        try {
          await api('/api/items/reorder', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, menuId: selectedMenuId, newIndex }),
          });
          await loadContent();
        } catch (e) {
          toast((e as Error).message, true);
          await loadContent();
        }
      },
    });
  }
}

// ---------------- 全屏预览(关灯式,支持左右切换) ----------------
interface PreviewItem {
  src: string;
  title: string;
  filename?: string;
  kind: 'image' | 'video' | 'pdf' | 'word' | 'excel';
}
let PREVIEW_LIST: PreviewItem[] = [];
let previewIndex = 0;
let previewDir: 'in' | 'next' | 'prev' = 'in'; // 切换方向,驱动滑入动画

function renderPreview() {
  const item = PREVIEW_LIST[previewIndex];
  const body = $('#lightbox-body');
  const title = $('#lightbox-title');
  if (!item || !body) return;
  // 方向 class 加在舞台(.lb-stage)上,CSS 据此选择滑入方向;innerHTML 重建会重放动画
  body.classList.remove('dir-next', 'dir-prev');
  if (previewDir === 'next') body.classList.add('dir-next');
  else if (previewDir === 'prev') body.classList.add('dir-prev');
  if (item.kind === 'word' || item.kind === 'excel') {
    // Office 文档:先放加载占位,异步解析后填充(客户端 SheetJS / mammoth)
    body.innerHTML = `<div class="lb-office"><div class="lb-office-loading"><i class="fa-solid fa-spinner fa-spin"></i> 正在加载预览…</div></div>`;
    loadOfficePreview(item, previewIndex);
  } else {
    body.innerHTML =
      item.kind === 'video'
        ? `<video src="${item.src}" controls autoplay playsinline></video>`
        : item.kind === 'pdf'
          ? `<iframe class="lb-doc" src="${item.src}" title="${escapeHtml(item.title)}"></iframe>`
          : `<img src="${item.src}" alt="${escapeHtml(item.title)}" />`;
  }
  if (title) {
    title.textContent =
      PREVIEW_LIST.length > 1
        ? `${item.title} · ${previewIndex + 1}/${PREVIEW_LIST.length}`
        : item.title;
  }
  // 仅一张时隐藏左右切换
  const multi = PREVIEW_LIST.length > 1;
  const prev = $('#lb-prev');
  const next = $('#lb-next');
  if (prev) prev.hidden = !multi;
  if (next) next.hidden = !multi;
}

// Office 文档客户端解析:按需懒加载 CDN 库(避免首屏体积),失败则降级为下载
const OFFICE_CDN = {
  xlsx: 'https://cdn.jsdelivr.net/npm/xlsx@0.20.2/dist/xlsx.full.min.js',
  mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
};
const loadedOfficeLibs: Record<string, Promise<any>> = {};
function loadOfficeLib(name: 'xlsx' | 'mammoth'): Promise<any> {
  if (!loadedOfficeLibs[name]) {
    loadedOfficeLibs[name] = new Promise((resolve, reject) => {
      const g = window as any;
      if (name === 'xlsx' && g.XLSX) return resolve(g.XLSX);
      if (name === 'mammoth' && g.mammoth) return resolve(g.mammoth);
      const s = document.createElement('script');
      s.src = OFFICE_CDN[name];
      s.async = true;
      s.onload = () => resolve(name === 'xlsx' ? g.XLSX : g.mammoth);
      s.onerror = () => reject(new Error('预览组件加载失败'));
      document.head.appendChild(s);
    });
  }
  return loadedOfficeLibs[name];
}

async function loadOfficePreview(item: PreviewItem, myIndex: number) {
  const applyHtml = (html: string) => {
    if (previewIndex !== myIndex) return; // 已切换到别的素材,丢弃过期结果
    const box = $('#lightbox-body')?.querySelector('.lb-office');
    if (box) box.innerHTML = html;
  };
  const fail = (msg: string) => {
    applyHtml(
      `<div class="lb-office-fallback">
         <i class="fa-solid fa-triangle-exclamation"></i>
         <p>${escapeHtml(msg)}</p>
         <button class="btn btn-primary" data-act="lb-download" data-url="${item.src}"><i class="fa-solid fa-download"></i> 下载后查看</button>
       </div>`,
    );
  };
  try {
    const res = await fetch(item.src); // 同源,自动带登录 cookie
    if (!res.ok) throw new Error('文件读取失败');
    const buf = await res.arrayBuffer();
    if (item.kind === 'excel') {
      const XLSX = await loadOfficeLib('xlsx');
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
      const html = (wb.SheetNames as string[])
        .slice(0, 5)
        .map((n) => `<div class="lb-sheet"><h4>${escapeHtml(n)}</h4>${XLSX.utils.sheet_to_html(wb.Sheets[n], { editable: false })}</div>`)
        .join('');
      applyHtml(html || '<div class="lb-office-fallback"><p>(空表格)</p></div>');
    } else {
      const fname = (item.filename || '').toLowerCase();
      if (fname.endsWith('.doc') && !fname.endsWith('.docx')) {
        fail('旧版 .doc 格式不支持在线预览,请下载后用 Word 打开。');
        return;
      }
      const mammoth = await loadOfficeLib('mammoth');
      const result = await mammoth.convertToHtml({ arrayBuffer: buf });
      applyHtml(`<div class="lb-word">${result.value || '<p>(空文档)</p>'}</div>`);
    }
  } catch {
    fail('预览组件加载失败(可能网络受限)或文件解析出错,请下载后查看。');
  }
}

function openLightboxAt(index: number) {
  if (!PREVIEW_LIST.length) return;
  previewDir = 'in';
  previewIndex = ((index % PREVIEW_LIST.length) + PREVIEW_LIST.length) % PREVIEW_LIST.length;
  renderPreview();
  openModal('lightbox');
}

function stepPreview(delta: number) {
  if (PREVIEW_LIST.length < 2) return;
  previewDir = delta > 0 ? 'next' : 'prev';
  previewIndex = (previewIndex + delta + PREVIEW_LIST.length) % PREVIEW_LIST.length;
  renderPreview();
}

function closeLightbox() {
  closeModal('lightbox');
  const body = $('#lightbox-body');
  if (body) body.innerHTML = ''; // 清空以停止视频播放
}

function initLightbox() {
  $('#lb-close')?.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    closeLightbox();
  });
  $('#lb-prev')?.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    stepPreview(-1);
  });
  $('#lb-next')?.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    stepPreview(1);
  });
  // 点击空白(遮罩)关闭;点在媒体/按钮上不关闭
  $('#lightbox')?.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // 降级下载按钮(Office 预览失败时)
    const dlBtn = target.closest('[data-act="lb-download"]');
    if (dlBtn) {
      e.stopPropagation();
      const u = (dlBtn as HTMLElement).dataset.url || '';
      if (u) window.location.href = `${u}${u.includes('?') ? '&' : '?'}download=1`;
      return;
    }
    // 点在媒体/Office 面板/按钮上不关闭
    if (target.closest('img, video, iframe, button, .lb-office')) return;
    closeLightbox();
  });
  // 键盘:← → 切换,Esc 关闭
  document.addEventListener('keydown', (e) => {
    if (!$('#lightbox')?.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') stepPreview(-1);
    else if (e.key === 'ArrowRight') stepPreview(1);
  });
}

// ---------------- 每行列数(卡片密度,账户级持久化) ----------------
// 设备默认:PC 12 列 / 手机 3 列;账户已保存的值(users.grid_cols)优先
const COLS_DEFAULT_PC = 12;
const COLS_DEFAULT_MOBILE = 3;

function persistCols(n: number) {
  // 账户级保存到服务端,跨设备生效;失败不阻塞本地即时生效
  api('/api/me/prefs', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gridCols: n }),
  }).catch(() => {
    /* 忽略保存失败,本地已生效 */
  });
}

function applyCols(n: number) {
  const grid = $('#card-grid');
  if (!grid) return;
  grid.style.setProperty('--grid-cols', String(n));
  grid.classList.toggle('compact', n >= 10);
}
function initColControl() {
  const root = $('#cols-control');
  const trigger = $('#col-trigger');
  const label = $('#col-label');
  const menu = $('#col-menu');
  if (!root || !trigger || !menu) return;

  const isMobile = window.matchMedia('(max-width: 640px)').matches;
  const saved = ME?.user?.gridCols ?? null;
  const initial = isMobile ? COLS_DEFAULT_MOBILE : saved ?? COLS_DEFAULT_PC;

  const setActive = (n: number) => {
    if (label) label.textContent = `${n} 列`;
    menu.querySelectorAll('.cols-option').forEach((o: Element) => {
      const el = o as HTMLElement;
      el.classList.toggle('active', parseInt(el.dataset.cols || '', 10) === n);
    });
  };
  const setOpen = (open: boolean) => {
    root.classList.toggle('open', open);
    trigger.setAttribute('aria-expanded', String(open));
  };

  trigger.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    setOpen(!root.classList.contains('open'));
  });
  menu.querySelectorAll('.cols-option').forEach((o: Element) => {
    (o as HTMLElement).addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      const n = parseInt((o as HTMLElement).dataset.cols || '6', 10) || 6;
      applyCols(n);
      setActive(n);
      setOpen(false);
      persistCols(n);
    });
  });
  // 点击外部 / Esc 关闭
  document.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  setActive(initial);
  applyCols(initial);
}

// ---------------- 菜单 增删改 ----------------
let editingMenuId: string | null = null;
let menuParentId: string | null = null;

function openMenuModal(parentId: string | null, name: string, editId?: string) {
  if (!activeOrgId) return toast('请先选择公司', true);
  editingMenuId = editId ?? null;
  menuParentId = parentId;
  $('#menu-modal-title')!.textContent = editId ? '重命名菜单' : '新增菜单';
  const parentName = parentId ? menuPath(MENUS, parentId).join(' › ') : '顶级(一级菜单)';
  ($('#menu-parent-label') as HTMLInputElement).value = parentName;
  ($('#menu-name') as HTMLInputElement).value = name;
  openModal('menu-modal');
  setTimeout(() => $('#menu-name')?.focus(), 50);
}

async function deleteMenu(id: string) {
  const m = findMenu(MENUS, id);
  if (!confirm(`确定删除菜单「${m?.name}」及其所有子菜单和素材?`)) return;
  try {
    await api(`/api/menus/${id}`, { method: 'DELETE' });
    if (selectedMenuId === id) selectedMenuId = null;
    toast('已删除');
    await loadContent();
  } catch (e) {
    toast((e as Error).message, true);
  }
}

// ---------------- 素材 新增(上传) ----------------
function openItemModal() {
  if (!selectedMenuId) return toast('请先在左侧选择一个菜单', true);
  pendingUpload = null;
  ($('#item-menu-label') as HTMLInputElement).value = menuPath(MENUS, selectedMenuId).join(' › ');
  ($('#item-title') as HTMLInputElement).value = '';
  ($('#file-preview') as HTMLElement).classList.add('hidden');
  ($('#file-preview') as HTMLElement).innerHTML = '';
  ($('#upload-status') as HTMLElement).textContent = '';
  ($('#item-save') as HTMLButtonElement).disabled = true;
  ($('#file-input') as HTMLInputElement).value = '';
  openModal('item-modal');
}

async function uploadFile(file: File, kind: 'main' | 'thumb'): Promise<any> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('kind', kind);
  // 上传需要带 org 头
  const res = await fetch('/api/upload', { method: 'POST', headers: orgHeaders(), body: fd });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '上传失败');
  return data;
}

function generateVideoThumb(file: File): Promise<Blob | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    const objUrl = URL.createObjectURL(file);
    video.src = objUrl;
    const cleanup = () => URL.revokeObjectURL(objUrl);
    video.onloadeddata = () => {
      try {
        video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
      } catch {
        cleanup();
        resolve(null);
      }
    };
    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 320;
      canvas.height = video.videoHeight || 240;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        cleanup();
        resolve(null);
        return;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (b) => {
          cleanup();
          resolve(b);
        },
        'image/jpeg',
        0.7,
      );
    };
    video.onerror = () => {
      cleanup();
      resolve(null);
    };
  });
}

async function handleFileChosen(file: File) {
  const status = $('#upload-status') as HTMLElement;
  const preview = $('#file-preview') as HTMLElement;
  // 客户端仅做基本白名单拦截;最终类型由服务端按 mime+扩展名权威判定
  const looksMedia = file.type.startsWith('video/') || file.type.startsWith('image/');
  const okExt = /\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|ogv|mov|m4v|pdf|docx?|xlsx?)$/i.test(
    file.name,
  );
  if (!looksMedia && !okExt) {
    return toast('仅支持图片、视频、PDF、Word、Excel', true);
  }

  status.textContent = '上传中…';
  ($('#item-save') as HTMLButtonElement).disabled = true;
  try {
    const main = await uploadFile(file, 'main');
    const type = main.type as ItemType; // 服务端权威判定:image/video/pdf/word/excel
    let thumbKey: string | null = null;
    let thumbUrl: string | null = null;
    if (type === 'video') {
      status.textContent = '生成视频缩略图…';
      const blob = await generateVideoThumb(file);
      if (blob) {
        const thumbFile = new File([blob], 'thumb.jpg', { type: 'image/jpeg' });
        const thumb = await uploadFile(thumbFile, 'thumb');
        thumbKey = thumb.key;
        thumbUrl = thumb.url;
      }
    }
    pendingUpload = {
      type,
      fileKey: main.key,
      fileUrl: main.url,
      mime: main.mime,
      size: main.size,
      filename: main.filename,
      thumbKey,
      thumbUrl,
    };
    // 预览区:图片/视频直接展示,PDF 内嵌,Word/Excel 显示类型图标
    const meta = TYPE_META[type];
    const sizeMb = (file.size / 1024 / 1024).toFixed(1);
    const cap = `<div class="text-xs text-slate-500">${escapeHtml(file.name)}<br/>${meta.label} · ${sizeMb}MB</div>`;
    preview.classList.remove('hidden');
    if (type === 'image') preview.innerHTML = `<img src="${main.url}" alt="预览"/>${cap}`;
    else if (type === 'video') preview.innerHTML = `<video src="${main.url}" muted></video>${cap}`;
    else if (type === 'pdf')
      preview.innerHTML = `<iframe class="preview-doc" src="${main.url}" title="PDF 预览"></iframe>${cap}`;
    else
      preview.innerHTML = `<div class="doc-icon ${meta.cls}"><i class="fa-solid ${meta.icon}"></i></div>${cap}`;
    const titleInput = $('#item-title') as HTMLInputElement;
    if (!titleInput.value) titleInput.value = file.name.replace(/\.[^.]+$/, '');
    status.textContent = '上传完成,可保存。';
    ($('#item-save') as HTMLButtonElement).disabled = false;
  } catch (e) {
    status.textContent = '';
    toast((e as Error).message, true);
  }
}

async function saveItem() {
  if (!pendingUpload || !selectedMenuId) return;
  const title = (($('#item-title') as HTMLInputElement).value || pendingUpload.filename).trim();
  try {
    await api('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menuId: selectedMenuId,
        type: pendingUpload.type,
        title,
        fileKey: pendingUpload.fileKey,
        fileUrl: pendingUpload.fileUrl,
        thumbKey: pendingUpload.thumbKey,
        thumbUrl: pendingUpload.thumbUrl,
        mime: pendingUpload.mime,
        size: pendingUpload.size,
        filename: pendingUpload.filename,
      }),
    });
    closeModal('item-modal');
    toast('已添加素材');
    await loadContent();
  } catch (e) {
    toast((e as Error).message, true);
  }
}

// ---------------- 公司管理 ----------------
async function openOrgModal() {
  openModal('org-modal');
  await refreshOrgList();
}
async function refreshOrgList() {
  const { orgs } = await api<{ orgs: Org[] }>('/api/orgs');
  const host = $('#org-list') as HTMLElement;
  host.innerHTML = orgs.length
    ? orgs
        .map(
          (o) => `<div class="list-row">
            <span class="grow">${escapeHtml(o.name)} <span class="text-xs text-slate-400">(${o.slug})</span></span>
            <button class="mini-btn" data-act="switch-org" data-id="${o.id}" title="切换到此公司"><i class="fa-solid fa-arrow-right"></i></button>
            <button class="mini-btn danger" data-act="del-org" data-id="${o.id}" data-name="${escapeHtml(o.name)}" title="删除公司"><i class="fa-solid fa-trash"></i></button>
          </div>`,
        )
        .join('')
    : `<div class="text-sm text-slate-400 py-3">还没有公司,先在上方添加。</div>`;

  host.querySelectorAll('[data-act="del-org"]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = (b as HTMLElement).dataset.id!;
      const name = (b as HTMLElement).dataset.name!;
      if (!confirm(`确定删除公司「${name}」?其所有菜单、素材、用户都将被删除!`)) return;
      try {
        await api(`/api/orgs/${id}`, { method: 'DELETE' });
        toast('公司已删除');
        if (activeOrgId === id) {
          activeOrgId = null;
          selectedMenuId = null;
        }
        await refreshOrgSwitcher();
        await refreshOrgList();
        await loadContent();
      } catch (e) {
        toast((e as Error).message, true);
      }
    }),
  );
  host.querySelectorAll('[data-act="switch-org"]').forEach((b) =>
    b.addEventListener('click', async () => {
      activeOrgId = (b as HTMLElement).dataset.id!;
      selectedMenuId = null;
      const sel = $('#org-switcher') as HTMLSelectElement;
      if (sel) sel.value = activeOrgId;
      closeModal('org-modal');
      await loadContent();
    }),
  );
}
async function refreshOrgSwitcher() {
  if (!isSuper) return;
  const { orgs } = await api<{ orgs: Org[] }>('/api/orgs');
  const sel = $('#org-switcher') as HTMLSelectElement | null;
  if (!sel) return;
  sel.innerHTML = orgs
    .map((o) => `<option value="${o.id}" ${o.id === activeOrgId ? 'selected' : ''}>${escapeHtml(o.name)}</option>`)
    .join('');
  if (!activeOrgId && orgs.length) {
    activeOrgId = orgs[0].id;
    sel.value = activeOrgId;
  }
}

// ---------------- 用户管理 ----------------
async function openUserModal() {
  openModal('user-modal');
  const orgSel = $('#user-org-select') as HTMLSelectElement;
  const orgField = $('#user-org-field') as HTMLElement;
  if (isSuper && ME?.orgs) {
    orgField.classList.remove('hidden');
    orgSel.innerHTML = ME.orgs
      .map((o) => `<option value="${o.id}" ${o.id === activeOrgId ? 'selected' : ''}>${escapeHtml(o.name)}</option>`)
      .join('');
  } else {
    orgField.classList.add('hidden');
  }
  await refreshUserList();
}
async function refreshUserList() {
  const orgSel = $('#user-org-select') as HTMLSelectElement;
  const queryOrg = isSuper ? orgSel?.value || activeOrgId : activeOrgId;
  if (!queryOrg) {
    ($('#user-list') as HTMLElement).innerHTML = `<div class="text-sm text-slate-400 py-3">请先选择公司</div>`;
    return;
  }
  const { users } = await api<{ users: any[] }>(`/api/users?orgId=${encodeURIComponent(queryOrg)}`);
  ($('#user-list') as HTMLElement).innerHTML = users.length
    ? users
        .map(
          (u) => `<div class="list-row">
            <span class="grow">${escapeHtml(u.username)}</span>
            <span class="tag ${u.role}">${u.role}</span>
            ${u.role === 'superadmin' ? '' : `<button class="mini-btn danger" data-del="${u.id}" title="删除"><i class="fa-solid fa-trash"></i></button>`}
          </div>`,
        )
        .join('')
    : `<div class="text-sm text-slate-400 py-3">该公司暂无用户。</div>`;

  ($('#user-list') as HTMLElement).querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('确定删除该用户?')) return;
      try {
        await api(`/api/users/${(b as HTMLElement).dataset.del}`, { method: 'DELETE' });
        toast('用户已删除');
        await refreshUserList();
      } catch (e) {
        toast((e as Error).message, true);
      }
    }),
  );
}

// ---------------- 弹窗事件绑定 ----------------
function bindModals() {
  // 菜单保存
  $('#menu-save')?.addEventListener('click', async () => {
    const name = (($('#menu-name') as HTMLInputElement).value || '').trim();
    if (!name) return toast('菜单名称不能为空', true);
    try {
      if (editingMenuId) {
        await api(`/api/menus/${editingMenuId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        toast('已重命名');
      } else {
        await api('/api/menus', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, parentId: menuParentId }),
        });
        toast('已新增菜单');
      }
      closeModal('menu-modal');
      await loadContent();
    } catch (e) {
      toast((e as Error).message, true);
    }
  });

  // 素材:文件选择 + 拖拽
  const dz = $('#dropzone') as HTMLElement;
  const fi = $('#file-input') as HTMLInputElement;
  dz?.addEventListener('click', () => fi.click());
  fi?.addEventListener('change', () => {
    if (fi.files?.[0]) handleFileChosen(fi.files[0]);
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    dz?.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('dragover');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz?.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
    }),
  );
  dz?.addEventListener('drop', (e) => {
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) handleFileChosen(f);
  });
  $('#item-save')?.addEventListener('click', saveItem);

  // 公司新增
  $('#add-org')?.addEventListener('click', async () => {
    const input = $('#new-org-name') as HTMLInputElement;
    const name = input.value.trim();
    if (!name) return toast('公司名称不能为空', true);
    try {
      const { org } = await api<{ org: Org }>('/api/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      input.value = '';
      toast('公司已创建');
      await refreshOrgSwitcher();
      await refreshOrgList();
      // 自动切到新公司
      activeOrgId = org.id;
      selectedMenuId = null;
      const sel = $('#org-switcher') as HTMLSelectElement;
      if (sel) sel.value = org.id;
      await loadContent();
    } catch (e) {
      toast((e as Error).message, true);
    }
  });

  // 用户新增
  $('#add-user')?.addEventListener('click', async () => {
    const username = (($('#new-user-name') as HTMLInputElement).value || '').trim();
    const password = ($('#new-user-pass') as HTMLInputElement).value || '';
    const role = ($('#new-user-role') as HTMLSelectElement).value;
    const orgId = isSuper ? ($('#user-org-select') as HTMLSelectElement).value : activeOrgId;
    if (!username || !password) return toast('用户名和密码不能为空', true);
    try {
      await api('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role, orgId }),
      });
      ($('#new-user-name') as HTMLInputElement).value = '';
      ($('#new-user-pass') as HTMLInputElement).value = '';
      toast('用户已创建');
      await refreshUserList();
    } catch (e) {
      toast((e as Error).message, true);
    }
  });
  $('#user-org-select')?.addEventListener('change', refreshUserList);
}

// 启动
init().catch((e) => {
  console.error(e);
  toast((e as Error).message || '初始化失败', true);
});
