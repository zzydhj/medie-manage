// 客户端主逻辑:渲染菜单树与素材卡片、管理员编辑、上传到 R2、拖拽排序、公司/用户管理。
// 所有写操作通过 X-Org-Id 头声明当前公司作用域(超级管理员),普通用户由服务端强制用自身公司。
import Sortable from 'sortablejs';
import { createZip, uniqueName, type ZipEntry } from './zip';

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
// 搜索关键词:空=按菜单浏览;非空=全公司范围按标题/文件名过滤
let searchQuery = '';
// 个人收藏(服务端按账户存储):素材 id 集合;favView=当前展示收藏视图
let FAVORITES = new Set<string>();
let favView = false;
// 批量选择:开启后点卡片=勾选(不再打开预览),可逐个下载 / 多文件分享
let selectMode = false;
const SELECTED = new Set<string>();
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

// 手机端断点:与 global.css 的 @media (max-width: 767px) 保持一致
const MOBILE_QUERY = '(max-width: 767px)';
function isMobileViewport(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}

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
        resetSearch();
        loadContent();
      });
    }
    $('#btn-companies')?.classList.remove('hidden');
  }
  // 用户管理入口:超级管理员 + 公司管理员
  if (isAdmin) $('#btn-users')?.classList.remove('hidden');

  bindHeader();
  initMobileNav();
  bindModals();
  // 点空白处 / 按 Esc / 滚动页面时关闭卡片三点菜单弹层(弹层是 fixed,滚动后会错位)
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.card-menu-wrap') && !(e.target as HTMLElement).closest('.card-menu-pop'))
      closeCardMenus();
  });
  window.addEventListener('scroll', () => closeCardMenus(), true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCardMenus();
  });
  initColControl();
  initSearch();
  initBatch();
  initLightbox();

  // 手机端首屏默认进“收藏”视图:高频入口,免去每次翻菜单
  if (isMobileViewport()) favView = true;

  await loadContent();
}

function bindHeader() {
  $('#btn-logout')?.addEventListener('click', doLogout);
  $('#btn-companies')?.addEventListener('click', openOrgModal);
  $('#btn-users')?.addEventListener('click', openUserModal);
  $('#btn-batch')?.addEventListener('click', () => setSelectMode(!selectMode));

  // 侧栏抽屉开合(平板用顶栏汉堡按钮,手机用底部导航“菜单”)
  $('#menu-toggle')?.addEventListener('click', () => toggleSidebarDrawer());
  $('#sidebar-overlay')?.addEventListener('click', () => toggleSidebarDrawer(false));

  // 新增一级菜单
  $('#add-root-menu')?.addEventListener('click', () => openMenuModal(null, ''));
}

// ---------------- 手机端:底部导航 / 搜索抽屉 / 账户 sheet ----------------
// 窄屏时把顶栏里的搜索框、公司切换器“搬”进手机端容器(同一个 DOM 节点,
// 事件与输入状态不丢);回到宽屏再搬回顶栏,避免两套输入源不同步。
function relocateForViewport() {
  const header = $('.app-header') as HTMLElement | null;
  const dock = $('#mobile-search');
  const sc = $('#search-control');
  if (header && dock && sc) {
    if (isMobileViewport()) {
      if (sc.parentElement !== dock) dock.appendChild(sc);
    } else if (sc.parentElement !== header) {
      header.insertBefore(sc, $('#cols-control'));
    }
  }
  const slot = $('#account-org-field');
  const sel = $('#org-switcher');
  if (header && slot && sel) {
    if (isMobileViewport()) {
      if (sel.parentElement !== slot) slot.appendChild(sel);
    } else if (sel.parentElement !== header) {
      header.insertBefore(sel, header.querySelector('.spacer'));
    }
  }
}

// 同步底部导航高亮:搜索条展开或有关键词时点亮“搜索”,抽屉/sheet 开启时点亮对应键
function syncMobileNav() {
  $('#mnav-search')?.classList.toggle(
    'active',
    !!searchQuery.trim() || document.body.classList.contains('search-open'),
  );
  $('#mnav-menu')?.classList.toggle('active', !!$('#sidebar')?.classList.contains('open'));
  $('#mnav-batch')?.classList.toggle('active', selectMode);
  $('#mnav-account')?.classList.toggle('active', !!$('#account-sheet')?.classList.contains('open'));
}

function openMobileSearch(open: boolean) {
  document.body.classList.toggle('search-open', open);
  if (open) {
    const input = $('#search-input') as HTMLInputElement | null;
    // 等抽屉滑到位再聚焦,避免 iOS 上键盘与动画打架
    window.setTimeout(() => input?.focus(), 150);
  }
  syncMobileNav();
}

function openAccountSheet(open: boolean) {
  $('#account-sheet')?.classList.toggle('open', open);
  $('#account-mask')?.classList.toggle('open', open);
  syncMobileNav();
}

function toggleSidebarDrawer(force?: boolean) {
  const sidebar = $('#sidebar');
  const open = force ?? !sidebar?.classList.contains('open');
  sidebar?.classList.toggle('open', open);
  $('#sidebar-overlay')?.classList.toggle('open', open);
  syncMobileNav();
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

function initMobileNav() {
  relocateForViewport();
  window.matchMedia(MOBILE_QUERY).addEventListener('change', () => {
    relocateForViewport();
    // 回到桌面:收起手机端浮层,并重渲染卡片(分享/复制按钮随视口切换)
    if (!isMobileViewport()) {
      document.body.classList.remove('search-open');
      openAccountSheet(false);
    }
    syncMobileNav();
    renderGrid();
  });

  // 账户 sheet:顶栏在手机上已隐藏,身份与管理入口在此补齐
  if (ME) {
    const roleLabel =
      ME.user.role === 'superadmin' ? '超级管理员' : ME.user.role === 'admin' ? '公司管理员' : '普通用户';
    const orgName = ME.org?.name ?? ME.orgs?.find((o) => o.id === activeOrgId)?.name ?? '';
    const name = $('#account-name');
    if (name) name.textContent = ME.user.username;
    const role = $('#account-role');
    if (role) role.textContent = orgName ? `${orgName} · ${roleLabel}` : roleLabel;
    if (isSuper) {
      $('#account-org-field')?.classList.remove('hidden');
      $('#account-companies')?.classList.remove('hidden');
    }
    if (isAdmin) $('#account-users')?.classList.remove('hidden');
  }

  $('#mnav-search')?.addEventListener('click', () =>
    openMobileSearch(!document.body.classList.contains('search-open')),
  );
  $('#mnav-menu')?.addEventListener('click', () => toggleSidebarDrawer());
  $('#mnav-batch')?.addEventListener('click', () => setSelectMode(!selectMode));
  $('#mnav-account')?.addEventListener('click', () =>
    openAccountSheet(!$('#account-sheet')?.classList.contains('open')),
  );
  $('#account-close')?.addEventListener('click', () => openAccountSheet(false));
  $('#account-mask')?.addEventListener('click', () => openAccountSheet(false));
  $('#account-logout')?.addEventListener('click', doLogout);
  $('#account-companies')?.addEventListener('click', () => {
    openAccountSheet(false);
    openOrgModal();
  });
  $('#account-users')?.addEventListener('click', () => {
    openAccountSheet(false);
    openUserModal();
  });
  syncMobileNav();
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
  const data = await api<{ menus: MenuNode[]; items: ItemDTO[]; favorites?: string[] }>('/api/content');
  MENUS = data.menus;
  ITEMS = data.items;
  FAVORITES = new Set(data.favorites ?? []);

  // 默认选中第一个叶子菜单;收藏视图下不预选(手机端首屏即收藏)
  if (!favView && (!selectedMenuId || !findMenu(MENUS, selectedMenuId))) {
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
function countFavItems(): number {
  return ITEMS.filter((i) => FAVORITES.has(i.id)).length;
}
// 收藏虚拟节点:固定菜单树最顶,跨菜单展示个人收藏(非真菜单:无子级/不可拖/不进菜单管理)
function renderFavRow(): string {
  return `
    <div class="menu-node fav-node">
      <div class="menu-row fav-row ${favView ? 'active' : ''}" data-fav="1">
        <span class="menu-caret"></span>
        <i class="fa-solid fa-star fav-icon"></i>
        <span class="menu-label">收藏</span>
        <span class="menu-count">${countFavItems()}</span>
      </div>
    </div>`;
}
function updateFavCount() {
  const el = document.querySelector('.fav-row .menu-count');
  if (el) el.textContent = String(countFavItems());
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
  host.innerHTML = renderFavRow() + renderMenuList(MENUS, '', 1);
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
            <span class="menu-label" title="${escapeHtml(n.name)}">${escapeHtml(n.name)}</span>
            <span class="menu-count">${countItemsIn(n.id)}</span>
            <span class="menu-actions">${handle}${adminBtns}</span>
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
      // 收藏虚拟节点:进入收藏视图(跨菜单、个人)
      if (row.dataset.fav) {
        favView = true;
        resetSearch();
        document.querySelectorAll('.menu-row.active').forEach((r) => r.classList.remove('active'));
        row.classList.add('active');
        renderGrid();
        // 移动端选中后收起侧栏
        if (window.innerWidth < 1024) toggleSidebarDrawer(false);
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
      favView = false;
      resetSearch();
      document.querySelectorAll('.menu-row.active').forEach((r) => r.classList.remove('active'));
      row.classList.add('active');
      renderGrid();
      // 移动端选中后收起侧栏
      if (window.innerWidth < 1024) toggleSidebarDrawer(false);
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
  if (!grid) return;

  if (!activeOrgId) {
    grid.innerHTML = `<div class="empty-hint">请先在上方选择或创建一个公司</div>`;
    return;
  }
  const q = searchQuery.trim().toLowerCase();
  const searching = q.length > 0;

  if (!searching && !favView && !selectedMenuId) {
    grid.innerHTML = `<div class="empty-hint">${
      isAdmin ? '左侧还没有菜单,点击"新增一级菜单"开始' : '暂无内容'
    }</div>`;
    return;
  }

  const items = (
    searching
      ? // 搜索模式:跨菜单匹配标题或文件名
        ITEMS.filter(
          (i) =>
            (i.title || '').toLowerCase().includes(q) ||
            (i.filename || '').toLowerCase().includes(q),
        )
      : favView
        ? // 收藏视图:跨菜单,仅展示我加星的素材
          ITEMS.filter((i) => FAVORITES.has(i.id))
        : ITEMS.filter((i) => i.menu_id === selectedMenuId)
  ).sort((a, b) => a.sort_order - b.sort_order);

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

  const mobile = isMobileViewport();
  // 卡片动作键:分享是手机端能力(需系统提供分享入口),电脑端用复制/下载/批量逐个下载
  const canShare = shareSupported();

  // 批量勾选只在当前列表内有效:切菜单/搜索/切公司后,清掉已不在列表里的选中项
  if (selectMode) {
    const visible = new Set(items.map((i) => i.id));
    SELECTED.forEach((id) => {
      if (!visible.has(id)) SELECTED.delete(id);
    });
  }

  const cards = items
    .map((it) => {
      const meta = TYPE_META[it.type];
      const isMedia = it.type === 'image' || it.type === 'video';
      const previewSrc =
        it.type === 'video' ? it.thumb_url || '' : it.type === 'image' ? it.file_url : '';
      const pindex = pindexOf.get(it.id);
      const faved = FAVORITES.has(it.id);
      const showCopy = !mobile && it.type === 'image';
      const showShare = mobile && canShare;
      // 右上角统一圆形悬浮按钮:收藏星标 + 三点菜单(编辑/删除收纳在弹层里)
      const cardActions = `<div class="card-actions"><button class="card-fab fav ${
        faved ? 'on' : ''
      }" data-act="fav" data-id="${it.id}" title="${faved ? '取消收藏' : '收藏'}"><i class="fa-${
        faved ? 'solid' : 'regular'
      } fa-star"></i></button>${
        isAdmin
          ? `<div class="card-menu-wrap">
               <button class="card-fab menu" data-act="card-menu" data-id="${it.id}" title="更多操作"><i class="fa-solid fa-ellipsis-vertical"></i></button>
               <div class="card-menu-pop">
                 <button class="pop-item" data-act="edit-item" data-id="${it.id}"><i class="fa-solid fa-pen"></i>编辑</button>
                 <button class="pop-item danger" data-act="del-item" data-id="${it.id}"><i class="fa-solid fa-trash"></i>删除</button>
               </div>
             </div>`
          : ''
      }</div>`;
      // 下载按钮旁的动作键(同尺寸、并列在左侧):手机=分享,电脑图片=复制
      const shareBtn =
        (showShare
          ? `<button class="copy-btn share solo" data-act="share-item" data-id="${it.id}" title="分享"><i class="fa-solid fa-share-nodes"></i></button>`
          : '') +
        (showCopy
          ? `<button class="copy-btn" data-act="copy-image" data-url="${it.file_url}" title="复制图片"><i class="fa-regular fa-copy"></i></button>`
          : '');
      const thumbInner = isMedia
        ? previewSrc
          ? `<img src="${previewSrc}" alt="${escapeHtml(it.title)}" loading="lazy" />`
          : `<div class="text-slate-300 text-xs">无预览</div>`
        : `<div class="doc-icon ${meta.cls}"><i class="fa-solid ${meta.icon}"></i></div>`;
      return `
        <div class="media-card${SELECTED.has(it.id) ? ' picked' : ''}" data-id="${it.id}"${
          pindex !== undefined ? ` data-pindex="${pindex}"` : ''
        }>
          <div class="media-thumb" data-preview="${it.file_url}" data-kind="${
            it.type
          }" data-title="${escapeHtml(it.title)}">
            <span class="card-check"><i class="fa-solid fa-check"></i></span>
            ${thumbInner}
            <span class="type-badge ${meta.cls}">${meta.label}</span>
            ${it.type === 'video' ? `<span class="play-badge"><i class="fa-solid fa-circle-play"></i></span>` : ''}
            <button class="download-btn" data-act="download" data-url="${it.file_url}" data-name="${escapeHtml(
              it.filename || it.title,
            )}" title="下载"><i class="fa-solid fa-download"></i></button>
            ${shareBtn}
            ${cardActions}
          </div>
          <div class="card-title" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</div>
        </div>`;
    })
    .join('');

  const addTile =
    isAdmin && !searching && !favView
      ? `<div class="add-card" id="add-item-tile"><i class="fa-solid fa-plus"></i><span>添加素材</span></div>`
      : '';

  const emptyHint =
    items.length === 0
      ? searching
        ? `<div class="empty-hint">未找到匹配“${escapeHtml(searchQuery.trim())}”的素材</div>`
        : favView
          ? `<div class="empty-hint">还没有收藏,点击卡片右上角的星标即可添加</div>`
          : isAdmin
            ? ''
            : `<div class="empty-hint">该菜单下暂无素材</div>`
      : '';
  grid.innerHTML = cards + addTile + emptyHint;

  bindGrid();
  if (selectMode) updateBatchBar();
}

let cardSortable: Sortable | null = null;

/** 复制图片到剪贴板:非 PNG 原图先经 canvas 转 PNG;需 HTTPS 或 localhost 安全上下文 */
async function copyImageToClipboard(url: string): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('当前浏览器不支持复制图片,请下载后使用');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error('获取图片失败');
  let blob = await res.blob();
  if (blob.type !== 'image/png') {
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 不可用');
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('转 PNG 失败'))), 'image/png'),
    );
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
// 各类型的通用 MIME 与探测文件名:仅用于渲染前同步判断系统是否允许分享该类型
const MIME_BY_TYPE: Record<ItemType, string> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  pdf: 'application/pdf',
  word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
/**
 * 是否存在系统分享入口。
 * 只看 navigator.share 存不存在:能不能分享“文件本体”得等真正调用时才知道
 * (桌面 Chrome 的 canShare({files}) 结果并不可靠),拿它做渲染门控会让按钮直接消失。
 */
function shareSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.share;
}

/** 取素材文件本体并包成 File(单个分享 / 批量分享都要用) */
async function fetchItemFile(it: ItemDTO): Promise<File> {
  const res = await fetch(it.file_url);
  if (!res.ok) throw new Error(`「${it.title}」获取失败(${res.status})`);
  const blob = await res.blob();
  return new File([blob], it.filename || it.title, { type: blob.type || MIME_BY_TYPE[it.type] });
}

/** 系统分享:取文件本体 → File → 原生分享面板(微信/QQ/WhatsApp 等由用户在面板里选) */
async function shareItemFile(id: string): Promise<void> {
  const it = ITEMS.find((i) => i.id === id);
  if (!it) throw new Error('素材不存在');
  if (!navigator.share) throw new Error('当前浏览器不支持分享,请改用下载');
  const file = await fetchItemFile(it);
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: it.title, text: it.title });
    return;
  }
  // 桌面浏览器多数不允许分享文件本体:退一步分享链接(注意:链接需登录才能打开)
  await navigator.share({
    title: it.title,
    text: it.title,
    url: new URL(it.file_url, window.location.href).href,
  });
  toast('此浏览器不支持分享文件本体,已改为分享链接(对方需登录才能打开)');
}

// ---------------- 批量选择(逐个下载 / 多文件分享) ----------------
function initBatch() {
  $('#batch-exit')?.addEventListener('click', () => setSelectMode(false));
  $('#batch-all')?.addEventListener('click', togglePickAll);
  $('#batch-download')?.addEventListener('click', () => batchDownload(false));
  $('#batch-zip')?.addEventListener('click', () => batchDownload(true));
  $('#batch-share')?.addEventListener('click', batchShare);
  // Esc 退出批量模式
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selectMode) setSelectMode(false);
  });
}

/** 进入 / 退出批量模式:卡片左上角出现勾选框,点卡片即选中(不再打开预览) */
function setSelectMode(on: boolean) {
  if (selectMode === on) return;
  selectMode = on;
  SELECTED.clear();
  document.body.classList.toggle('select-mode', on);
  closeCardMenus();
  renderGrid(); // 重建卡片与拖拽(批量模式下禁用拖拽排序)
  updateBatchBar();
  syncMobileNav();
  if (on) toast('已开启批量:点卡片勾选,再选下方动作');
}

function pickedItems(): ItemDTO[] {
  return Array.from(SELECTED)
    .map((id) => ITEMS.find((i) => i.id === id))
    .filter((x): x is ItemDTO => !!x);
}

function cardIdsOnScreen(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.media-card[data-id]')).map(
    (c) => c.dataset.id!,
  );
}

function togglePick(id: string) {
  if (!id) return;
  if (SELECTED.has(id)) SELECTED.delete(id);
  else SELECTED.add(id);
  document
    .querySelector(`.media-card[data-id="${id}"]`)
    ?.classList.toggle('picked', SELECTED.has(id));
  updateBatchBar();
}

function togglePickAll() {
  const ids = cardIdsOnScreen();
  const allPicked = ids.length > 0 && ids.every((id) => SELECTED.has(id));
  SELECTED.clear();
  if (!allPicked) ids.forEach((id) => SELECTED.add(id));
  document.querySelectorAll<HTMLElement>('.media-card[data-id]').forEach((c) => {
    c.classList.toggle('picked', SELECTED.has(c.dataset.id!));
  });
  updateBatchBar();
}

/** 刷新操作条:计数、按钮文案与可用性(分享键仅在系统支持时出现) */
function updateBatchBar() {
  const bar = $('#batch-bar');
  if (!bar) return;
  const n = SELECTED.size;
  const count = $('#batch-count');
  if (count) count.textContent = String(n);
  bar.classList.toggle('hidden', !selectMode);

  const ids = cardIdsOnScreen();
  const allPicked = ids.length > 0 && ids.every((id) => SELECTED.has(id));
  const allLabel = $('#batch-all')?.querySelector('span');
  if (allLabel) allLabel.textContent = allPicked ? '取消全选' : '全选';

  $('#batch-share')?.classList.toggle('hidden', !shareSupported() || !isMobileViewport());
  const dlLabel = $('#batch-download')?.querySelector('span');
  if (dlLabel) dlLabel.textContent = n > 1 ? `下载 ${n} 个` : '下载';
  const shareLabel = $('#batch-share')?.querySelector('span');
  if (shareLabel) shareLabel.textContent = n > 1 ? `分享 ${n} 个` : '分享';

  ['#batch-download', '#batch-zip', '#batch-share'].forEach((sel) => {
    const b = $(sel) as HTMLButtonElement | null;
    if (b) b.disabled = n === 0;
  });
}

/**
 * 批量下载。
 * 默认“逐个下载”:依次触发每个文件的下载,拿到的就是原始文件、不经压缩。
 * 浏览器策略:第 1 个必放行,之后属于“网站自动下载多个文件”,Chrome/Edge 会在
 * 地址栏弹一次“允许下载多个文件?”,点允许后本站不再询问;Safari 需在网站设置里放开。
 * asZip=true 时改为在浏览器里打包成一个 ZIP(被拦截时的备选)。
 */
async function batchDownload(asZip: boolean) {
  const items = pickedItems();
  if (!items.length) return toast('请先勾选素材', true);
  const btn = $(asZip ? '#batch-zip' : '#batch-download') as HTMLButtonElement | null;
  const html = btn?.innerHTML ?? '';
  if (btn) btn.disabled = true;
  try {
    if (!asZip) {
      for (let i = 0; i < items.length; i++) {
        triggerDownload(items[i].file_url, items[i].filename || items[i].title);
        setBatchProgress(btn, i + 1, items.length);
        // 逐个之间留一点间隔:太快会被浏览器当成下载轰炸而整批拦截
        if (i < items.length - 1) await sleep(350);
      }
      toast(
        items.length > 1
          ? `已依次触发 ${items.length} 个下载;若浏览器询问“允许下载多个文件”,点允许即可`
          : '已开始下载',
      );
      return;
    }
    const entries: ZipEntry[] = [];
    const used = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const res = await fetch(it.file_url);
      if (!res.ok) throw new Error(`「${it.title}」下载失败(${res.status})`);
      entries.push({
        name: uniqueName(it.filename || it.title, used),
        data: new Uint8Array(await res.arrayBuffer()),
      });
      setBatchProgress(btn, i + 1, items.length);
    }
    const d = new Date();
    const p = (x: number) => String(x).padStart(2, '0');
    triggerBlobDownload(
      createZip(entries),
      `素材打包_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.zip`,
    );
    toast(`已打包 ${entries.length} 个文件`);
  } catch (err) {
    toast((err as Error).message || '下载失败', true);
  } finally {
    if (btn) btn.innerHTML = html;
    updateBatchBar();
  }
}

/** 批量分享:一次把多个文件交给系统分享面板(微信/QQ 可一次收多张图 + PDF) */
async function batchShare() {
  const items = pickedItems();
  if (!items.length) return toast('请先勾选素材', true);
  if (!navigator.share) return toast('当前浏览器不支持分享,请改用下载', true);
  const btn = $('#batch-share') as HTMLButtonElement | null;
  const html = btn?.innerHTML ?? '';
  if (btn) btn.disabled = true;
  try {
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      files.push(await fetchItemFile(items[i]));
      setBatchProgress(btn, i + 1, items.length);
    }
    if (!navigator.canShare?.({ files })) throw new Error('系统不支持一次分享这些文件,请改用下载');
    await navigator.share({ files, title: `素材 ${files.length} 个` });
  } catch (err) {
    // 用户在系统面板里点取消属正常操作,不报错
    if ((err as Error)?.name !== 'AbortError') toast((err as Error).message || '分享失败', true);
  } finally {
    if (btn) btn.innerHTML = html;
    updateBatchBar();
  }
}

function setBatchProgress(btn: HTMLElement | null, done: number, total: number) {
  if (btn && total > 1)
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>${done}/${total}</span>`;
}

function sleep(ms: number) {
  return new Promise((r) => window.setTimeout(r, ms));
}

/** 触发单个文件下载:同源 + 服务端 Content-Disposition,点 a 标签不会跳走页面 */
function triggerDownload(url: string, name: string) {
  const a = document.createElement('a');
  a.href = `${url}${url.includes('?') ? '&' : '?'}download=1`;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function triggerBlobDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function bindGrid() {
  // 下载
  document.querySelectorAll<HTMLElement>('[data-act="download"]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = b.dataset.url!;
      window.location.href = `${url}${url.includes('?') ? '&' : '?'}download=1`;
    });
  });
  // 复制图片(仅图片卡):取原图 → 必要时转 PNG → 写剪贴板
  document.querySelectorAll<HTMLElement>('[data-act="copy-image"]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const icon = b.querySelector('i');
      try {
        await copyImageToClipboard(b.dataset.url!);
        toast('图片已复制,可直接粘贴');
        if (icon) {
          icon.className = 'fa-solid fa-check';
          window.setTimeout(() => (icon.className = 'fa-regular fa-copy'), 1200);
        }
      } catch (err) {
        toast((err as Error).message, true);
      }
    });
  });
  // 分享(手机端,所有类型):取文件本体调起系统分享面板
  document.querySelectorAll<HTMLElement>('[data-act="share-item"]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const icon = b.querySelector('i');
      const restore = () => {
        if (icon) icon.className = 'fa-solid fa-share-nodes';
      };
      const btn = b as HTMLButtonElement;
      btn.disabled = true;
      if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
      try {
        await shareItemFile(b.dataset.id!);
        if (icon) icon.className = 'fa-solid fa-check';
        window.setTimeout(restore, 1200);
      } catch (err) {
        // 用户在系统面板里点取消属正常操作,不报错
        if ((err as Error)?.name !== 'AbortError') toast((err as Error).message || '分享失败', true);
        restore();
      } finally {
        btn.disabled = false;
      }
    });
  });
  // 删除卡片
  document.querySelectorAll<HTMLElement>('[data-act="del-item"]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeCardMenus();
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
  // 收藏开关(所有用户:个人收藏,乐观更新 + 服务端同步)
  document.querySelectorAll<HTMLElement>('[data-act="fav"]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = b.dataset.id!;
      const on = !FAVORITES.has(id);
      const icon = b.querySelector('i');
      const paint = (v: boolean) => {
        b.classList.toggle('on', v);
        if (icon) icon.className = v ? 'fa-solid fa-star' : 'fa-regular fa-star';
        b.title = v ? '取消收藏' : '收藏';
      };
      // 乐观更新:先改本地状态与样式,失败再回滚
      if (on) FAVORITES.add(id);
      else FAVORITES.delete(id);
      paint(on);
      updateFavCount();
      try {
        await api('/api/favorites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId: id, on }),
        });
        // 收藏视图下加/取消收藏会改变卡片列表,重渲染
        if (favView && !searchQuery.trim()) renderGrid();
      } catch (err) {
        if (on) FAVORITES.delete(id);
        else FAVORITES.add(id);
        paint(!on);
        updateFavCount();
        toast((err as Error).message, true);
      }
    });
  });
  // 三点菜单:开关小弹层(弹层挂到 body 用 fixed 定位,避免被卡片 overflow:hidden 裁剪;
  // 点页面其它处 / Esc / 滚动时关闭,见 init 里的全局监听)
  document.querySelectorAll<HTMLElement>('[data-act="card-menu"]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrap = b.parentElement;
      const pop = wrap?.querySelector('.card-menu-pop') as HTMLElement | null;
      if (!pop) return;
      const wasOpen = pop.classList.contains('open');
      closeCardMenus();
      if (wasOpen) return;
      // 传送到 body:卡片 overflow:hidden 会裁剪 absolute 弹层,fixed + 视口坐标才能完整显示
      menuPopHome = wrap!; // 记住原容器,关闭时送回
      document.body.appendChild(pop);
      pop.classList.add('open');
      const r = b.getBoundingClientRect();
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      // 默认在按钮右侧弹出;视口右缘不够时翻到左侧
      const flip = r.right + 8 + w > window.innerWidth;
      pop.classList.toggle('flip', flip);
      pop.style.top = `${Math.max(8, Math.min(r.top - 2, window.innerHeight - h - 8))}px`;
      if (flip) {
        pop.style.left = 'auto';
        pop.style.right = `${window.innerWidth - r.left + 8}px`;
      } else {
        pop.style.right = 'auto';
        pop.style.left = `${r.right + 8}px`;
      }
    });
  });
  // 编辑:调出标题 / 所属分组弹窗(入口在三点菜单里)
  document.querySelectorAll<HTMLElement>('[data-act="edit-item"]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCardMenus();
      openItemEditModal(b.dataset.id!);
    });
  });
  // 预览:图片/视频/PDF 打开全屏预览并支持左右切换;Word/Excel 不支持在线预览,点击转下载
  document.querySelectorAll<HTMLElement>('.media-thumb').forEach((t) => {
    t.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-act]')) return;
      const card = t.closest('.media-card') as HTMLElement | null;
      // 批量模式:点卡片 = 勾选 / 取消,不打开预览
      if (selectMode) {
        togglePick(card?.dataset.id || '');
        return;
      }
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
  if (cardSortable) {
    cardSortable.destroy();
    cardSortable = null; // 置空,避免对已销毁实例重复 destroy 抛 "Cannot set properties of null"
  }
  const grid = $('#card-grid');
  // 搜索/收藏视图下禁用拖拽排序(跨菜单结果排序无意义,且 reorder 依赖 selectedMenuId);
  // 批量模式下也禁用:长按拖拽会和勾选打架
  if (isAdmin && grid && !searchQuery.trim() && !favView && !selectMode) {
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

// ---------------- 素材 编辑(标题 / 所属分组) ----------------
let editingItemId: string | null = null;

// 当前打开的三点弹层的原容器(弹层打开时被传送到 body,关闭时送回)
let menuPopHome: HTMLElement | null = null;

function closeCardMenus() {
  // 关闭弹层并送回原卡片的 .card-menu-wrap;若卡片已被重渲染移除则直接丢弃弹层
  document.querySelectorAll<HTMLElement>('.card-menu-pop.open').forEach((p) => {
    p.classList.remove('open');
    if (menuPopHome?.isConnected) {
      menuPopHome.appendChild(p);
    } else {
      p.remove();
    }
  });
  menuPopHome = null;
}

/** 菜单树拍平成带缩进的选项列表,供编辑弹窗选分组 */
function flattenMenus(nodes: MenuNode[], depth = 1, out: { id: string; label: string }[] = []) {
  nodes.forEach((n) => {
    out.push({ id: n.id, label: '\u3000'.repeat(depth - 1) + n.name });
    flattenMenus(n.children, depth + 1, out);
  });
  return out;
}

function openItemEditModal(id: string) {
  const item = ITEMS.find((i) => i.id === id);
  if (!item) return;
  editingItemId = id;
  ($('#item-edit-title') as HTMLInputElement).value = item.title || '';
  const sel = $('#item-edit-menu') as HTMLSelectElement;
  sel.innerHTML = flattenMenus(MENUS)
    .map(
      (m) =>
        `<option value="${m.id}" ${m.id === item.menu_id ? 'selected' : ''}>${escapeHtml(m.label)}</option>`,
    )
    .join('');
  openModal('item-edit-modal');
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

// Office 文档客户端解析:动态 import 本地打包的库(同源、不依赖 CDN),
// Vite 会把 xlsx / mammoth 各拆成懒加载 chunk,仅在首次预览文档时才下载
const loadedOfficeLibs: Record<string, Promise<any>> = {};
function loadOfficeLib(name: 'xlsx' | 'mammoth'): Promise<any> {
  if (!loadedOfficeLibs[name]) {
    loadedOfficeLibs[name] = (
      name === 'xlsx'
        ? import('xlsx') // 命名导出:read / utils 直接挂在命名空间上
        : import('mammoth/mammoth.browser.js').then((m: any) => m.default ?? m) // UMD,default 即 mammoth 对象
    ).catch((e: any) => {
      delete loadedOfficeLibs[name]; // 加载失败时清缓存,允许下次重试
      throw e;
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
// ---------------- 搜索(按文件名 / 标题,全公司范围) ----------------
// 清空搜索状态与输入框;不触发渲染,由调用方决定何时 renderGrid
function resetSearch() {
  searchQuery = '';
  const input = $('#search-input') as HTMLInputElement | null;
  if (input) input.value = '';
  $('#search-clear')?.classList.add('hidden');
  syncMobileNav();
}

function initSearch() {
  const input = $('#search-input') as HTMLInputElement | null;
  const clearBtn = $('#search-clear');
  if (!input) return;
  // 进入/刷新页面强制清空:浏览器会恢复输入框旧值,但搜索状态不应跨页保留
  input.value = '';
  searchQuery = '';
  clearBtn?.classList.add('hidden');
  // 兜底:若浏览器在脚本之后才恢复旧值(load 时框有值但搜索状态为空),清掉
  window.addEventListener('load', () => {
    if (input.value && !searchQuery) {
      input.value = '';
      clearBtn?.classList.add('hidden');
    }
  });
  // 前进/后退(bfcache)恢复整页状态时,清空搜索保持一致
  window.addEventListener('pageshow', (e: PageTransitionEvent) => {
    if (e.persisted) {
      resetSearch();
      renderGrid();
    }
  });
  let timer: number | undefined;
  const apply = () => {
    searchQuery = input.value;
    renderGrid();
    syncMobileNav();
  };
  const clear = () => {
    window.clearTimeout(timer);
    resetSearch();
    renderGrid();
  };
  input.addEventListener('input', () => {
    clearBtn?.classList.toggle('hidden', input.value.length === 0);
    // 轻微防抖,避免每敲一个字都重渲染整片卡片
    window.clearTimeout(timer);
    timer = window.setTimeout(apply, 150);
  });
  clearBtn?.addEventListener('click', () => {
    clear();
    input.focus();
  });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') clear();
  });
}

function initColControl() {
  const root = $('#cols-control');
  const trigger = $('#col-trigger');
  const label = $('#col-label');
  const menu = $('#col-menu');
  if (!root || !trigger || !menu) return;

  const isMobile = isMobileViewport();
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
      // 卡片宽度变了,动作键的取舍也跟着变(紧凑卡放不下分享+复制),重渲染一次
      renderGrid();
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

  // 素材编辑保存:改标题 / 换分组(与移动卡片同一接口)
  $('#item-edit-save')?.addEventListener('click', async () => {
    if (!editingItemId) return;
    const title = (($('#item-edit-title') as HTMLInputElement).value || '').trim();
    if (!title) return toast('标题不能为空', true);
    const menuId = ($('#item-edit-menu') as HTMLSelectElement).value;
    try {
      await api(`/api/items/${editingItemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, menuId }),
      });
      toast('已保存');
      closeModal('item-edit-modal');
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
