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
  size: number | null; // 批量上传去重用(与 filename 联合判重)
  duration: number | null; // 视频时长(秒):卡片左下角时长胶囊
  sort_order: number;
}
interface Org {
  id: string;
  name: string;
  slug: string;
  expires_at: number | null;
}
interface Me {
  user: { id: string; username: string; role: string; orgId: string | null; gridCols: number | null };
  orgs?: Org[];
  org?: Org;
  activeOrgId: string | null;
  orgExpired?: boolean; // 服务端判定:所属公司会员已到期(可浏览不可操作)
}

// ---------------- 全局状态 ----------------
let ME: Me | null = null;
let activeOrgId: string | null = null;
let MENUS: MenuNode[] = [];
let ITEMS: ItemDTO[] = [];
// 分页:ITEMS 为"已加载窗口";TOTAL/HAS_MORE 驱动无限滚动;COUNTS/FAV_COUNT 为服务端聚合计数
let PAGE = 1;
const PAGE_SIZE = 36;
let TOTAL = 0;
let HAS_MORE = false;
let loadingMore = false;
let COUNTS: Record<string, number> = {};
// 直挂计数(服务端未聚合版):父级徽章 = 直挂 + 子树,徽章 tooltip 用它解释与子级之和的差值
let DIRECT_COUNTS: Record<string, number> = {};
let FAV_COUNT = 0;
let selectedMenuId: string | null = null;
// 搜索关键词:空=按菜单浏览;非空=全公司范围按标题/文件名过滤
let searchQuery = '';
// 个人收藏(服务端按账户存储):素材 id 集合;favView=当前展示收藏视图
let FAVORITES = new Set<string>();
let favView = false;
// 类型快捷筛选:''=全部;与搜索/菜单/收藏视图可叠加,参与缓存键与视图记忆
type TypeFilter = '' | 'image' | 'video' | 'doc';
let typeFilter: TypeFilter = '';
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
  duration: number | null;
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

// 卡片预览图加载失败自愈:缩略图对象缺失/损坏→回退原图(data-fb);原图也失败→
// 换"无预览"占位,杜绝坏 img 让卡片永久空白(老库缩略图对象丢失时不用管理员手动补图)
(window as unknown as Record<string, unknown>).__mmImgErr = (img: HTMLImageElement) => {
  const fb = img.dataset.fb;
  if (fb) {
    delete img.dataset.fb;
    img.src = fb;
    return;
  }
  const ph = document.createElement('div');
  ph.className = 'text-slate-300 text-xs';
  ph.textContent = '无预览';
  img.replaceWith(ph);
};

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
  if (!res.ok) {
    // 超管中途设置到期:在线收到 403 到期错误立即锁屏(不等下次刷新)
    if (res.status === 403 && data?.error === '会员已到期,请续费后使用') enterLockMode();
    throw new Error((data && data.error) || `请求失败(${res.status})`);
  }
  return data as T;
}

// ---------------- 提示 ----------------
let toastTimer: number | undefined;
function toast(msg: string, isError = false, duration = 2200) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), duration);
}

// ---------------- 弹窗 ----------------
function openModal(id: string) {
  $(`#${id}`)?.classList.add('open');
}
function closeModal(id: string) {
  $(`#${id}`)?.classList.remove('open');
}
/** 会员到期拦截:到期公司账号能看不能动,点任何功能统一弹续费大弹窗;
 *  服务端 middleware 对写请求另有 403 兜底,正常走不到 */
function expiryGuard(): boolean {
  if (!ME?.orgExpired) return false;
  openModal('expiry-modal');
  return true;
}

// ---------------- 会员到期锁屏(浏览也禁:服务端对到期公司拒发任何数据) ----------------
let locked = false;
/** 锁屏:全屏遮罩盖住整站(只剩退出登录),禁右键/拖拽/保存类快捷键并弹续费大弹窗。
 *  真正的墙在服务端:/api 全 403(含文件字节),浏览器拿不到数据,插件也无从保存 */
function enterLockMode() {
  if (locked) {
    openModal('expiry-modal');
    return;
  }
  locked = true;
  $('#lock-screen')?.classList.remove('hidden');
  $('#lock-logout')?.addEventListener('click', doLogout);
  openModal('expiry-modal');
  // 全局右键:禁默认菜单并弹续费弹窗,到期账号的「另存为」入口彻底掐掉
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openModal('expiry-modal');
  });
  // 拖图片/文本到桌面等同保存,一并禁止
  document.addEventListener('dragstart', (e) => e.preventDefault());
  // 保存/打印/看源码/开发者工具类快捷键
  document.addEventListener(
    'keydown',
    (e) => {
      const k = e.key.toLowerCase();
      const blocked =
        e.key === 'F12' ||
        (e.ctrlKey && !e.altKey && (k === 's' || k === 'p' || k === 'u')) ||
        (e.ctrlKey && e.shiftKey && (k === 'i' || k === 'j' || k === 'c'));
      if (blocked) {
        e.preventDefault();
        openModal('expiry-modal');
      }
    },
    true,
  );
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
      renderOrgOptions();
      $('#org-switch-wrap')?.classList.remove('hidden');
      sel.addEventListener('change', () => {
        activeOrgId = sel.value;
        selectedMenuId = null;
        // 切公司同样回「全部」筛选,与切菜单行为一致
        typeFilter = '';
        syncTypeFilterUI();
        saveView();
        resetSearch();
        updateExpiryChip();
        loadContent();
      });
    }
    $('#btn-companies')?.classList.remove('hidden');
  }
  initOrgExpiryPicker();
  updateExpiryChip();

  // 非超管:左上角显示静态公司名(与超管切换器同款白胶囊,只显自己公司、不可切)
  if (!isSuper) {
    const badge = $('#org-name-badge');
    const orgName = ME.org?.name ?? ME.orgs?.find((o) => o.id === activeOrgId)?.name ?? '';
    if (badge && orgName) {
      badge.textContent = orgName;
      badge.classList.remove('hidden');
    }
  }
  // 用户管理入口:超级管理员 + 公司管理员
  if (isAdmin) $('#btn-users')?.classList.remove('hidden');
  // 补缩略图:管理员一次性运维操作
  if (isAdmin) $('#btn-backfill')?.classList.remove('hidden');
  // 存储用量:管理员可见
  if (isAdmin) $('#btn-storage')?.classList.remove('hidden');
  // 批量管理(删除/移动)仅管理员可见:普通用户批量条只保留下载/分享
  if (isAdmin) {
    $('#batch-move')?.classList.remove('hidden');
    $('#batch-delete')?.classList.remove('hidden');
  }

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
  // 预热窗跳过按钮:进页就绑好(不能等 loadContent/预热开始才绑,冷启动慢时点了会没反应);
  // 点了立即收窗正常浏览,缓存在后台静默继续刷
  $('#warmup-skip')?.addEventListener('click', () => closeWarmupUi());
  // 无限滚动:接近底部(提前 800px)静默预取下一页
  window.addEventListener(
    'scroll',
    () => {
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 800) {
        loadMore().catch((e) => toast((e as Error).message, true));
      }
    },
    { passive: true },
  );
  // 窗口变大后可能又不足一屏:补页
  window.addEventListener('resize', () => {
    ensureFill();
  });

  // 会员到期:直接锁屏(不加载任何内容,服务端也已拒发),弹续费大弹窗
  if (ME.orgExpired) {
    enterLockMode();
    return;
  }
  // 新设备/无缓存首登:立即挂全屏预热进度窗并起跑时间进度(不等首屏),
  // 首屏渲染在弹窗背后照常进行;进度纯时间驱动 ~90s 到 100% 必收窗,
  // 缓存没刷完则转后台静默继续
  if (activeOrgId && warmupNeeded(activeOrgId)) {
    startWarmupUi();
    await loadContent();
    maybeWarmup().catch(() => {});
  } else {
    await loadContent();
  }
}

function bindHeader() {
  $('#btn-logout')?.addEventListener('click', doLogout);
  // 类型快捷筛选:分段 chips 点击切换,与搜索/菜单/收藏叠加;切回当前视图重拉
  $('#type-filter')?.addEventListener('click', (e: Event) => {
    const b = (e.target as HTMLElement).closest?.('.tf-chip') as HTMLElement | null;
    if (!b) return;
    const tf = (b.dataset.tf || '') as TypeFilter;
    if (tf === typeFilter) return;
    typeFilter = tf;
    syncTypeFilterUI();
    saveView();
    refreshList().catch((er) => toast((er as Error).message, true));
  });
  $('#btn-companies')?.addEventListener('click', openOrgModal);
  $('#btn-users')?.addEventListener('click', openUserModal);
  $('#btn-backfill')?.addEventListener('click', backfillThumbs);
  $('#btn-storage')?.addEventListener('click', openStorageModal);
  $('#btn-batch')?.addEventListener('click', () => setSelectMode(!selectMode));

  // 侧栏抽屉开合(平板用顶栏汉堡按钮,手机用底部导航“菜单”)
  $('#menu-toggle')?.addEventListener('click', () => toggleSidebarDrawer());
  $('#sidebar-overlay')?.addEventListener('click', () => toggleSidebarDrawer(false));

  // 新增一级菜单
  $('#add-root-menu')?.addEventListener('click', () => {
    if (expiryGuard()) return;
    openMenuModal(null, '');
  });
}

// 类型快捷筛选 chips:按当前 typeFilter 点亮激活项(初始/点击/视图恢复共用)
function syncTypeFilterUI() {
  document.querySelectorAll<HTMLElement>('#type-filter .tf-chip').forEach((c) => {
    c.classList.toggle('active', (c.dataset.tf || '') === typeFilter);
  });
}

// ---------------- 手机端:底部导航 / 搜索抽屉 / 账户 sheet ----------------
// 窄屏时把顶栏里的搜索框、公司切换器“搬”进手机端容器(同一个 DOM 节点,
// 事件与输入状态不丢);回到宽屏再搬回顶栏,避免两套输入源不同步。
function relocateForViewport() {
  const header = $('.app-header') as HTMLElement | null;
  const dock = $('#mobile-search');
  const sc = $('#search-control');
  const tf = $('#type-filter');
  if (header && dock && sc) {
    if (isMobileViewport()) {
      if (sc.parentElement !== dock) dock.appendChild(sc);
      // 筛选 chips 随搜索框一起进抽屉:手机上在搜索弹层里同样可切
      if (tf && tf.parentElement !== dock) dock.appendChild(tf);
    } else if (sc.parentElement !== header) {
      header.insertBefore(sc, $('#cols-control'));
      if (tf && tf.parentElement !== header) header.insertBefore(tf, sc);
    }
  }
  // 切换器 + 到期 chip 整体搬动:手机端超管也能在账户 sheet 里设到期日
  const slot = $('#account-org-field');
  const selWrap = $('#org-switch-wrap');
  if (header && slot && selWrap) {
    if (isMobileViewport()) {
      if (selWrap.parentElement !== slot) slot.appendChild(selWrap);
    } else if (selWrap.parentElement !== header) {
      header.insertBefore(selWrap, header.querySelector('.spacer'));
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
  } else {
    // 收回时失焦,避免抽屉已隐藏但软键盘还悬在屏幕上
    ($('#search-input') as HTMLInputElement | null)?.blur();
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
    if (isAdmin) $('#account-backfill')?.classList.remove('hidden');
    if (isAdmin) $('#account-storage')?.classList.remove('hidden');
  }

  $('#mnav-search')?.addEventListener('click', () =>
    openMobileSearch(!document.body.classList.contains('search-open')),
  );
  // 搜索抽屉展开时:点抽屉与搜索键以外的任意空白(卡片区/顶部留白)即收回
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('search-open')) return;
    const t = e.target as HTMLElement;
    if (t.closest('#mobile-search') || t.closest('#mnav-search')) return;
    openMobileSearch(false);
  });
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
  $('#account-backfill')?.addEventListener('click', () => {
    openAccountSheet(false);
    backfillThumbs();
  });
  $('#account-storage')?.addEventListener('click', () => {
    openAccountSheet(false);
    openStorageModal();
  });
  syncMobileNav();
}

// ---------------- 视图记忆(刷新后回到上次打开的菜单/收藏) ----------------
const VIEW_KEY = 'mm-last-view';
interface SavedView {
  orgId: string | null;
  menuId: string | null;
  fav: boolean;
  tf?: string;
}
function saveView() {
  try {
    localStorage.setItem(
      VIEW_KEY,
      JSON.stringify({ orgId: activeOrgId, menuId: selectedMenuId, fav: favView, tf: typeFilter }),
    );
  } catch {
    /* 隐私模式等写不了就忽略,不影响主流程 */
  }
}
function restoreView(): SavedView | null {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as SavedView;
    // 换公司不套用旧公司的视图
    if (v.orgId !== activeOrgId) return null;
    return v;
  } catch {
    return null;
  }
}

// ---------------- 分页加载 ----------------
interface PageData {
  items: ItemDTO[];
  total: number;
  favorites?: string[];
}
function viewQuery(page: number): string {
  const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (searchQuery.trim()) p.set('q', searchQuery.trim());
  else if (favView) p.set('fav', '1');
  else if (selectedMenuId) p.set('menuId', selectedMenuId);
  if (typeFilter) p.set('t', typeFilter);
  return p.toString();
}
// 页缓存:切回看过的视图/页直接命中内存,免网络往返 → 切换秒开;任何变更(loadContent/收藏)会清空
const pageCache = new Map<string, PageData>();
function pageCacheKey(page: number): string {
  return `${activeOrgId}|${searchQuery.trim()}|${typeFilter}|${favView ? 'fav' : selectedMenuId ?? ''}|${page}`;
}
function clearPageCache() {
  pageCache.clear();
}
async function fetchPage(page: number): Promise<PageData> {
  const key = pageCacheKey(page);
  const hit = pageCache.get(key);
  if (hit) return hit;
  const d = await api<PageData>(`/api/content?${viewQuery(page)}`);
  pageCache.set(key, d);
  if (pageCache.size > 60) {
    const oldest = pageCache.keys().next().value;
    if (oldest !== undefined) pageCache.delete(oldest);
  }
  return d;
}
// ---------------- 本地列表缓存(刷新秒开:stale-while-revalidate) ----------------
// 字节层靠 /api/file 的 immutable HTTP 缓存跨刷新保留;这里把"列表元数据"也落 localStorage,
// 刷新瞬间先画上次窗口,后台再拿新数据替换 → 只有第一次慢,后面全快
const LIST_CACHE_PREFIX = 'mm-list-';
const LIST_REGISTRY = 'mm-list-registry';
function listKey(): string {
  return `${LIST_CACHE_PREFIX}${activeOrgId}|${searchQuery.trim()}|${typeFilter}|${
    favView ? 'fav' : selectedMenuId ?? ''
  }`;
}
interface ListCache {
  items: ItemDTO[];
  total: number;
  favorites: string[];
  ts: number;
}
function readListCache(key: string): ListCache | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as ListCache;
    if (!d || !Array.isArray(d.items) || !d.items.length) return null;
    return d;
  } catch {
    return null;
  }
}
function writeListCache() {
  try {
    const key = listKey();
    // 列表已空:必须删掉旧缓存。否则(如删光某菜单)旧的非空列表仍躺在 localStorage,
    // 刷新后点该菜单会被 paintStaleList 先画出来(闪一下已删除的内容),等服务端返回空才清。
    if (!ITEMS.length) {
      localStorage.removeItem(key);
      const reg: string[] = JSON.parse(localStorage.getItem(LIST_REGISTRY) || '[]');
      localStorage.setItem(LIST_REGISTRY, JSON.stringify(reg.filter((k) => k !== key)));
      return;
    }
    const payload: ListCache = {
      items: ITEMS.slice(0, 500),
      total: TOTAL,
      favorites: [...FAVORITES],
      ts: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(payload));
    touchListRegistry(key);
  } catch {
    // 配额满/隐私模式:静默放弃缓存,不影响功能
  }
}
/** 注册表 LRU:留最近 N 个视图,超出的连数据一起淘汰,防 localStorage 膨胀 */
const LIST_CACHE_MAX_VIEWS = 30;
function touchListRegistry(key: string) {
  const reg: string[] = JSON.parse(localStorage.getItem(LIST_REGISTRY) || '[]');
  const next = [key, ...reg.filter((k) => k !== key)].slice(0, LIST_CACHE_MAX_VIEWS);
  reg.forEach((k) => {
    if (!next.includes(k)) localStorage.removeItem(k);
  });
  localStorage.setItem(LIST_REGISTRY, JSON.stringify(next));
}
/** 预取结果落盘 SWR 层:刷新后内存页缓存清零,点该分组仍能 paintStaleList 秒开首屏 */
function writePrefetchCache(key: string, d: PageData) {
  if (!d.items.length) return; // 空列表不写(与 readListCache 的非空校验对齐)
  try {
    const payload: ListCache = {
      items: d.items,
      total: d.total,
      favorites: d.favorites ?? [],
      ts: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(payload));
    touchListRegistry(key);
  } catch {
    // 配额满/隐私模式:静默放弃
  }
}
/** 用上次落的列表立即渲染(刷新秒开);返回是否命中 */
function paintStaleList(): boolean {
  const key = listKey();
  const stale = readListCache(key);
  if (!stale) return false;
  // 防串内容:菜单视图校验缓存项确属该菜单子树(历史污染缓存直接丢弃自愈);
  // 搜索/收藏视图素材本就越菜单,不校验;MENUS 未加载时也无法校验,跳过
  if (!favView && !searchQuery.trim() && selectedMenuId && MENUS.length) {
    const ids = new Set(subtreeIdsClient(MENUS, selectedMenuId));
    if (stale.items.some((it) => !ids.has(it.menu_id))) {
      try {
        localStorage.removeItem(key);
      } catch {
        // 忽略
      }
      return false;
    }
  }
  ITEMS = stale.items;
  TOTAL = stale.total;
  HAS_MORE = ITEMS.length < TOTAL;
  FAVORITES = new Set(stale.favorites);
  PAGE = Math.max(1, Math.ceil(ITEMS.length / PAGE_SIZE));
  renderGrid();
  animateGridEnterIfNewView();
  return true;
}
/** 视图切换时给网格(#card-grid)一次淡入+上移;时长见 CSS .view-enter(~420ms),用来盖住后台校验/补页/预载;同视图的后台替换不重复动画 */
let lastViewAnimKey = '';
function animateGridEnterIfNewView() {
  const key = listKey();
  if (key === lastViewAnimKey) return;
  lastViewAnimKey = key;
  const grid = $('#card-grid');
  if (!grid) return;
  grid.classList.remove('view-enter');
  void grid.offsetWidth; // 强制回流以重播动画
  grid.classList.add('view-enter');
}
/** 并行拉连续多页(刷新/补页/预载共用):多页同发,免串行往返 */
async function fetchWindow(from: number, pages: number) {
  const nums: number[] = [];
  for (let p = from; p < from + pages; p++) nums.push(p);
  const ds = await Promise.all(nums.map((p) => fetchPage(p)));
  let items: ItemDTO[] = [];
  let total = 0;
  let favorites: string[] | undefined;
  let used = 0;
  for (let i = 0; i < ds.length; i++) {
    total = ds[i].total;
    if (ds[i].favorites) favorites = ds[i].favorites;
    items = items.concat(ds[i].items);
    used = i + 1;
    if (ds[i].items.length < PAGE_SIZE) break;
  }
  return { items, total, favorites, pages: used };
}
function appendWindow(w: { items: ItemDTO[]; total: number; pages: number }) {
  ITEMS = ITEMS.concat(w.items);
  TOTAL = w.total;
  PAGE += w.pages;
  HAS_MORE = ITEMS.length < TOTAL;
  renderGrid();
}
/** 切换序列号:快速连点菜单时只允许最后一次点击的结果落地,过期响应/补页全部丢弃 */
let refreshSeq = 0;
async function ensureFill(seq = refreshSeq) {
  let guard = 0;
  while (
    HAS_MORE &&
    guard++ < 4 &&
    seq === refreshSeq &&
    document.documentElement.scrollHeight <= window.innerHeight + 300
  ) {
    const w = await fetchWindow(PAGE + 1, 3);
    // 补页返回后必须复查:这几页可能是切分组前发起的旧视图请求,
    // 不查就把旧分组素材拼进新列表(串内容),还会被 writeListCache 落盘固化
    if (seq !== refreshSeq) return;
    appendWindow(w);
  }
}
/** 后台静默预载剩余页:首屏填满后尽快把后面内容全量拉进已加载窗口,
 *  菜单打开即全部可见(不再"先 36 个、滚下去等半天")。10 页/波并行,波内同发、
 *  波间让出主线程防长任务;顺序追加保证排序不乱 */
let preloadSeq = 0;
function startPreload() {
  const seq = ++preloadSeq;
  (async () => {
    try {
      while (HAS_MORE && PAGE < 60 && seq === preloadSeq) {
        const w = await fetchWindow(PAGE + 1, 10);
        if (seq !== preloadSeq) return; // 用户已切走:作废
        appendWindow(w);
        await new Promise((r) => setTimeout(r, 0)); // 让出主线程,避免长任务卡交互
      }
      if (seq === preloadSeq) writeListCache(); // 全量窗口落盘,下次刷新秒开
    } catch {
      // 静默失败不骚扰:无限滚动仍可重试
    }
    if (seq === preloadSeq) updateGridFooter();
  })();
}
/** 重置到第一页并重渲染(切菜单/搜索/收藏/刷新列表用) */
async function refreshList() {
  const seq = ++refreshSeq; // 作废之前所有在飞的切换
  preloadSeq++; // 取消上一轮后台预载
  deepSeq++; // 取消上一轮深度预载
  const painted = paintStaleList(); // 上次窗口立即秒开
  if (!painted) {
    // 无旧缓存(如首次点筛选 chip):立即清空窗口态再铺骨架屏。
    // 否则 ITEMS/HAS_MORE/PAGE 还是旧视图的,骨架屏变矮会触发 scroll→loadMore,
    // 把新筛选的下一页 append 进旧列表 → 图片筛选里混进视频、内容跳动;
    // 清空后 HAS_MORE=false,loadMore 直接短路,新数据到达前网格只有骨架屏
    ITEMS = [];
    TOTAL = 0;
    HAS_MORE = false;
    PAGE = 1;
    renderSkeleton(); // 旧内容一律先换成骨架屏:新数据到达前绝不展示与筛选不符的卡片
  }
  // 有旧窗口时并行补到同等规模,替换一次到位;没有则只拉第一页
  const want = painted ? Math.min(10, Math.max(1, Math.ceil(ITEMS.length / PAGE_SIZE))) : 1;
  const w = await fetchWindow(1, want);
  if (seq !== refreshSeq) return; // 用户又切走了:这份结果作废,避免"点A显示B"
  PAGE = w.pages;
  ITEMS = w.items;
  TOTAL = w.total;
  HAS_MORE = ITEMS.length < TOTAL;
  if (w.favorites) FAVORITES = new Set(w.favorites);
  renderGrid();
  animateGridEnterIfNewView();
  // 动画(~420ms)进行中:并行补满首屏 → 落盘 → 预载后续页 → 深度预取,后台计算与渐变同步跑完
  await ensureFill(seq);
  if (seq !== refreshSeq) return;
  writeListCache();
  startPreload();
  scheduleDeepPrefetch();
}
async function loadMore() {
  if (loadingMore || !HAS_MORE) return;
  const seq = refreshSeq;
  loadingMore = true;
  updateGridFooter();
  try {
    const w = await fetchWindow(PAGE + 1, 1);
    if (seq !== refreshSeq) return; // 切换已发生:不要把旧视图的页混进新视图
    appendWindow(w);
    await ensureFill(seq);
  } finally {
    loadingMore = false;
    updateGridFooter();
  }
}
// ---------------- 深度预载:空闲 10s 后把其余素材字节拉进 HTTP 缓存(跨刷新/重启保留) ----------------
let deepTimer: number | undefined;
let deepSeq = 0;
const deepDone = new Set<string>();
function scheduleDeepPrefetch() {
  window.clearTimeout(deepTimer);
  deepTimer = window.setTimeout(() => {
    deepPrefetch().catch(() => {});
  }, 10000);
}
async function deepPrefetch() {
  if (warmupRunning) return; // 预热期间带宽全让给它:避免 7 路并发把卡片缩略图饿成长期空白
  if (isMobileViewport()) return; // 移动端省流量:缩略图仍按需懒加载
  const key = listKey();
  if (deepDone.has(key)) return;
  const seq = ++deepSeq;
  // 1) 元数据拿全:单独翻页,不动已加载窗口
  let all = ITEMS.slice();
  let total = TOTAL;
  let p = PAGE;
  while (all.length < total && p < 60 && seq === deepSeq) {
    p++;
    const d = await api<PageData>(`/api/content?${viewQuery(p)}`);
    total = d.total;
    all = all.concat(d.items);
  }
  if (seq !== deepSeq) return;
  deepDone.add(key);
  // 2) 字节进 HTTP 缓存:缩略图全量;原图仅图片且按 200MB 预算,避免撑爆缓存配额
  let budget = 200 * 1024 * 1024;
  const queue: string[] = [];
  for (const it of all) {
    if (it.thumb_url) queue.push(it.thumb_url);
    if (it.type === 'image' && it.file_url && (it.size ?? 0) <= budget) {
      queue.push(it.file_url);
      budget -= it.size ?? 0;
    }
  }
  let i = 0;
  const worker = async () => {
    while (i < queue.length && seq === deepSeq) {
      const url = queue[i++];
      try {
        const res = await fetch(url);
        await res.blob(); // 读完 body 才确保写入 HTTP 缓存;已缓存时命中磁盘秒回
      } catch {
        // 单个失败忽略,不影响整体
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}
/** 底部状态:还有更多时静默(不满一屏滚不动/满一屏看不见,提示均无意义);加载中转圈;加载完一句结束提示 */
function updateGridFooter() {
  const grid = $('#card-grid');
  if (!grid) return;
  let f = grid.querySelector('.grid-footer') as HTMLElement | null;
  if (ITEMS.length === 0 || (HAS_MORE && !loadingMore)) {
    f?.remove();
    return;
  }
  if (!f) {
    f = document.createElement('div');
    f.className = 'grid-footer';
    grid.appendChild(f);
  }
  if (loadingMore) f.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 加载中…';
  else f.textContent = `已加载全部 ${TOTAL} 个`;
}
/** 预取某视图第一页进页缓存:悬停/空闲时调用,切换命中缓存=秒开;
 *  同时落盘 localStorage:刷新后内存缓存清零,点该分组仍能旧窗口秒开再后台替换 */
function prefetchMenuPage(menuId: string | null, fav: boolean) {
  if (!activeOrgId) return;
  // 与 pageCacheKey 对齐:预取假定无搜索词(切菜单会 resetSearch)
  const view = fav ? 'fav' : menuId ?? '';
  // 与 pageCacheKey 对齐(无搜索词、无类型筛选):org|q|tf|view|page
  const key = `${activeOrgId}|||${view}|1`;
  if (pageCache.has(key)) return;
  const p = new URLSearchParams({ page: '1', pageSize: String(PAGE_SIZE) });
  if (fav) p.set('fav', '1');
  else if (menuId) p.set('menuId', menuId);
  api<PageData>(`/api/content?${p.toString()}`)
    .then((d) => {
      pageCache.set(key, d);
      writePrefetchCache(`${LIST_CACHE_PREFIX}${activeOrgId}|||${view}`, d);
    })
    .catch(() => {});
}
let prefetchTimer: number | undefined;
/** 首屏渲染稳定后,后台低速预取收藏+计数>0 的菜单第一页(上限12),不抢首屏带宽 */
function schedulePrefetch() {
  window.clearTimeout(prefetchTimer);
  const org = activeOrgId;
  const flat: string[] = [];
  const walk = (ns: MenuNode[]) =>
    ns.forEach((n) => {
      flat.push(n.id);
      if (n.children?.length) walk(n.children);
    });
  walk(MENUS);
  // 预取上限与 LRU 对齐(每个只一页小 JSON,400ms 一个不抢带宽),刷新后全部分组都能秒开
  const queue = flat.filter((id) => (COUNTS[id] ?? 0) > 0).slice(0, 29);
  let i = 0;
  const step = () => {
    if (activeOrgId !== org) return; // 切公司:预取作废
    if (i === 0) prefetchMenuPage(null, true);
    else prefetchMenuPage(queue[i - 1], false);
    i++;
    if (i <= queue.length) prefetchTimer = window.setTimeout(step, 400);
  };
  prefetchTimer = window.setTimeout(step, 1200);
}
// ---------------- 新设备首登预热:一次性把列表元数据 + 缩略图字节灌进缓存 ----------------
// 首次打开(本机无任何列表缓存)时全屏弹窗:进度条纯时间驱动(0 起跑,~90 秒到 100%),
// 到 100% 必收窗——缓存没刷完就转后台静默继续,做完落 done 标记,下次不再打扰
const WARMUP_PREFIX = 'mm-warmup-'; // + orgId:done=已完成 / skip=用户跳过或到点关窗(不再弹大窗)
const WARMUP_MAX_ITEMS = 2000; // 超大库封顶:先预热前 2000 个,其余靠日常深度预载补
const WARMUP_UI_MS = 90_000; // 进度窗固定时长:~1.1%/秒,90 秒到 100%
let warmupRunning = false;
let warmupUiTimer: number | undefined;
function warmupNeeded(orgId: string): boolean {
  if (localStorage.getItem(`${WARMUP_PREFIX}${orgId}`)) return false;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(LIST_CACHE_PREFIX)) return false; // 已有列表缓存=老设备,不预热
    }
  } catch {
    return false;
  }
  return true;
}
/** 弹预热窗并起跑时间进度:init 里先于 loadContent 调用,进度条从第一秒就走;
 *  按墙钟算进度,后台标签被定时器限流也不会拖长,到点必收 */
function startWarmupUi() {
  const overlay = $('#warmup-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  const t0 = Date.now();
  let tick = 0;
  window.clearInterval(warmupUiTimer);
  warmupUiTimer = window.setInterval(() => {
    tick++;
    const p = Math.min(100, Math.round(((Date.now() - t0) / WARMUP_UI_MS) * 100));
    const bar = $('#warmup-bar');
    const pct = $('#warmup-pct');
    if (bar) bar.style.width = `${p}%`;
    if (pct) pct.textContent = `${p}%`;
    if (tick % 32 === 0) healPendingThumbs(); // 每 ~8s 自愈一批网格卡死的空白缩略图
    if (p >= 100) closeWarmupUi(); // 到 100% 必关,不管缓存刷完没
  }, 250);
}
/** 收预热进度窗:关窗即落 skip 标记(不管跳过还是到点自动关)——缓存没刷完前刷新页面
 *  也不会再弹大窗,后台静默继续;真正刷完后 done 覆盖 skip */
function closeWarmupUi() {
  window.clearInterval(warmupUiTimer);
  warmupUiTimer = undefined;
  $('#warmup-overlay')?.classList.add('hidden');
  if (activeOrgId) {
    try {
      const key = `${WARMUP_PREFIX}${activeOrgId}`;
      if (localStorage.getItem(key) !== 'done') localStorage.setItem(key, 'skip');
    } catch {
      // localStorage 不可用时忽略
    }
  }
}
/** 自愈空白缩略图:网格里卡住没加载/加载失败的 img 强制重置 src 重拉一次(每个 img 限一次)。
 *  预热期间卡片缩略图请求可能被重渲染取消、或被并发带宽饿死,卡片就永久空白;
 *  自愈时 HTTP 缓存通常已暖,重置后瞬间完成 */
function healPendingThumbs() {
  document.querySelectorAll<HTMLImageElement>('#card-grid img').forEach((img) => {
    if (img.dataset.healed) return;
    if (img.complete && img.naturalWidth > 0) return; // 已正常加载,不动
    const s = img.getAttribute('src');
    if (!s) return;
    img.dataset.healed = '1';
    img.src = '';
    img.src = s; // 先空再还原:强制重新加载,缓存已暖=瞬间完成
  });
}
/** 实际预热工作:整库清单落页缓存 + 各菜单第一页落盘 + 全库缩略图字节灌 HTTP 缓存;
 *  进度窗已收(跳过/到点)也不中断,静默刷完落 done 标记 */
async function maybeWarmup() {
  if (!activeOrgId || warmupRunning) return;
  if (ME?.orgExpired || !warmupNeeded(activeOrgId)) return;
  warmupRunning = true;
  const org = activeOrgId;
  const report = (done: number, total: number) => {
    // 弹窗还开着才更新计数文案(进度条本身纯时间驱动,与这里无关)
    if (warmupUiTimer !== undefined && total) {
      const label = $('#warmup-label');
      if (label) label.textContent = `正在缓存素材预览 ${done} / ${total}`;
    }
  };
  try {
    // 1) 元数据全量:整库逐页拉清单(URL 与 pageCacheKey 同格式,顺带进页缓存),
    //    收藏 + 各菜单第一页落盘 → 切分组秒开
    const all: ItemDTO[] = [];
    let page = 0;
    let totalItems = Infinity;
    while (all.length < totalItems && page < 60) {
      page++;
      let d: PageData | null = null;
      for (let attempt = 0; attempt < 2 && !d; attempt++) {
        try {
          d = await api<PageData>(`/api/content?page=${page}&pageSize=${PAGE_SIZE}`);
        } catch {
          d = null; // 单页失败(冷启动/瞬时):重试一次,仍败则跳过该页
        }
      }
      if (!d) continue; // 不因一页失败 abort 整个预热:否则其余菜单的缩略图永远不缓存
      pageCache.set(`${activeOrgId}|||${page}`, d); // 整库视图页缓存:首屏翻页直接命中
      totalItems = d.total;
      all.push(...d.items);
      report(all.length, Math.min(totalItems, WARMUP_MAX_ITEMS));
      if (org !== activeOrgId) return; // 切公司:预热作废
    }
    await prefetchMenuPage(null, true);
    const flat: string[] = [];
    const walk = (ns: MenuNode[]) =>
      ns.forEach((n) => {
        flat.push(n.id);
        if (n.children?.length) walk(n.children);
      });
    walk(MENUS);
    // 逐菜单串行落第一页:并发齐发几十请求易打爆冷启动 Worker 出 500,反过来 abort 预热
    for (const id of flat) {
      if (org !== activeOrgId) return;
      await prefetchMenuPage(id, false);
    }
    // 2) 缩略图字节进 HTTP 缓存(immutable,跨刷新/重启保留)→ 卡片不再有白占位
    const seen = new Set<string>();
    const queue: string[] = [];
    const rest: string[] = [];
    // 卡片实际渲染的预览地址:缩略图优先;老图片无缩略图时挂的是原图→预热必须缓存原图字节
    const previewUrl = (it: ItemDTO) => it.thumb_url || (it.type === 'image' ? it.file_url : '');
    const curUrls = new Set(ITEMS.map(previewUrl).filter((u) => !!u));
    let imgBudget = 400 * 1024 * 1024; // 无缩略图老图片的原图预算:超出的留给按需懒加载+深度预载
    for (const it of all.slice(0, WARMUP_MAX_ITEMS)) {
      const url = previewUrl(it);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      if (!it.thumb_url && it.type === 'image') {
        const sz = it.size ?? 0;
        if (sz > imgBudget) continue;
        imgBudget -= sz;
      }
      // 当前视图排最前(用户正看的先不白),其余全库(所有菜单)随后
      (curUrls.has(url) ? queue : rest).push(url);
    }
    queue.push(...rest);
    const total = queue.length;
    let done = 0;
    let qi = 0;
    const worker = async () => {
      while (qi < queue.length) {
        const url = queue[qi++];
        try {
          const res = await fetch(url);
          await res.blob(); // 读完 body 才确保写入 HTTP 缓存
        } catch {
          // 单个失败忽略,不影响整体
        }
        done++;
        report(done, total);
      }
    };
    // 4 并发:比日常预载激进(此时用户就在等),又不至于把浏览器连接池占死
    await Promise.all([worker(), worker(), worker(), worker()]);
    localStorage.setItem(`${WARMUP_PREFIX}${org}`, 'done');
    healPendingThumbs(); // 缓存已暖:网格还卡着的空白缩略图强制重拉,瞬间完成
  } catch {
    // 网络异常等:静默放弃,不打扰用户;标记 skip 避免每次刷新都弹大窗
    try {
      localStorage.setItem(`${WARMUP_PREFIX}${org}`, 'skip');
    } catch {
      // localStorage 不可用时忽略
    }
    healPendingThumbs();
    closeWarmupUi();
  } finally {
    warmupRunning = false;
    scheduleDeepPrefetch(); // 预热结束(成功或失败)再排原图深度预载:预热期间被抑制
  }
}
/** 无缓存切换时立即铺骨架屏:视觉"瞬间有响应",避免空白等待感 */
function renderSkeleton() {
  const grid = $('#card-grid');
  if (!grid) return;
  grid.innerHTML = Array.from({ length: 12 })
    .map(() => `<div class="skel-card"><div class="skel-thumb"></div><div class="skel-line"></div></div>`)
    .join('');
}

// ---------------- 加载内容 ----------------
async function loadContent() {
  if (ME?.orgExpired) return; // 锁屏态:任何内容都不请求(服务端对到期公司全 403)
  clearPageCache(); // 任何结构性变更后旧页缓存作废
  if (!activeOrgId) {
    MENUS = [];
    ITEMS = [];
    TOTAL = 0;
    HAS_MORE = false;
    renderSidebar();
    renderGrid();
    return;
  }
  // 视图恢复纯读 localStorage:先定视图,立即用上次落的列表秒开(stale-while-revalidate)
  const saved = restoreView();
  typeFilter =
    saved?.tf === 'image' || saved?.tf === 'video' || saved?.tf === 'doc' ? saved.tf : '';
  syncTypeFilterUI();
  if (saved?.fav) {
    favView = true;
    selectedMenuId = null;
  } else if (saved?.menuId) {
    favView = false;
    selectedMenuId = saved.menuId;
  }
  const paintedStale = paintStaleList(); // 命中=刷新秒开;未命中再铺骨架屏
  if (!paintedStale) renderSkeleton();
  const meta = await api<{
    menus: MenuNode[];
    counts: Record<string, number>;
    directCounts?: Record<string, number>;
    favCount: number;
  }>('/api/content?meta=1');
  MENUS = meta.menus;
  COUNTS = meta.counts ?? {};
  DIRECT_COUNTS = meta.directCounts ?? {};
  FAV_COUNT = meta.favCount ?? 0;

  // 校验视图:无记录或已失效(菜单被删/换公司)则用默认(手机端首屏=收藏,电脑端=第一个叶子菜单)
  if (saved?.fav) {
    favView = true;
    selectedMenuId = null;
  } else if (saved?.menuId && findMenu(MENUS, saved.menuId)) {
    favView = false;
    selectedMenuId = saved.menuId;
  } else if (isMobileViewport()) {
    favView = true;
    selectedMenuId = null;
  } else {
    favView = false;
    selectedMenuId = firstLeafId(MENUS);
  }
  saveView(); // 把当前生效视图落盘,供下次刷新恢复
  renderSidebar(); // 树先出来:新建/改名菜单不必等素材页往返
  await refreshList(); // 内部:旧窗口秒开 → 并行拉新窗口替换 → 后台预载 → 落盘
  if (isAdmin) $('#add-root-menu')?.classList.remove('hidden');
  schedulePrefetch(); // 首屏稳定后后台预取各菜单第一页,让后续切换命中缓存
}

function findMenu(nodes: MenuNode[], id: string): MenuNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const f = findMenu(n.children, id);
    if (f) return f;
  }
  return null;
}
/** 客户端子树 id 集合(含自身):与服务端 subtreeIds 同语义,用于校验列表缓存是否串了别的分组 */
function subtreeIdsClient(nodes: MenuNode[], id: string): string[] {
  const target = findMenu(nodes, id);
  if (!target) return [];
  const out: string[] = [target.id];
  const walk = (ns: MenuNode[]) =>
    ns.forEach((n) => {
      out.push(n.id);
      if (n.children?.length) walk(n.children);
    });
  walk(target.children);
  return out;
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
// 侧栏计数直接读服务端聚合好的子树总数/收藏总数(分页后前端不再持有全量)
function countItemsIn(menuId: string): number {
  return COUNTS[menuId] ?? 0;
}
function countFavItems(): number {
  return FAV_COUNT;
}
/** 父级徽章 = 直挂 + 子树合计;既有直挂素材又有子菜单时给徽章加 tooltip,
 * 否则用户会因「父级数 ≠ 子级数之和」怀疑数据错了(差值正是直挂部分) */
function directHint(n: MenuNode): string {
  const d = DIRECT_COUNTS[n.id] ?? 0;
  return d > 0 && n.children?.length ? ` title="含 ${d} 个直挂本级"` : '';
}
// 收藏虚拟节点:固定菜单树最顶,跨菜单展示个人收藏(非真菜单:无子级/不可拖/不进菜单管理)
function renderFavRow(): string {
  const c = countFavItems();
  return `
    <div class="menu-node fav-node">
      <div class="menu-row fav-row ${favView ? 'active' : ''}" data-fav="1">
        <span class="menu-caret"></span>
        <i class="fa-solid fa-star fav-icon"></i>
        <span class="menu-label">收藏</span>
        <span class="menu-count${c ? '' : ' zero'}">${c}</span>
      </div>
    </div>`;
}
function updateFavCount() {
  const el = document.querySelector('.fav-row .menu-count');
  if (!el) return;
  const c = countFavItems();
  el.textContent = String(c);
  el.classList.toggle('zero', c === 0);
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
  // 记住当前展开的菜单,重建后恢复(否则重载/乐观插入会把展开态打掉)
  const openIds = new Set(
    Array.from(host.querySelectorAll('.menu-node.open')).map(
      (n) => (n as HTMLElement).dataset.id || '',
    ),
  );
  host.innerHTML = renderFavRow() + renderMenuList(MENUS, '', 1);
  openIds.forEach((id) => {
    if (id) host.querySelector(`.menu-node[data-id="${id}"]`)?.classList.add('open');
  });
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
           <button class="mini-btn" data-act="move-menu" data-id="${n.id}" title="移动到其它分组"><i class="fa-solid fa-folder-open"></i></button>
           <button class="mini-btn danger" data-act="del-menu" data-id="${n.id}" title="删除"><i class="fa-solid fa-trash"></i></button>`
        : '';
      const handle = isAdmin ? `<i class="fa-solid fa-grip-vertical drag-handle" title="拖拽排序"></i>` : '';
      const cnt = countItemsIn(n.id);
      return `
        <div class="menu-node menu-depth-${depth} ${hasKids ? '' : ''}" data-id="${n.id}">
          <div class="menu-row ${isActive ? 'active' : ''}" data-id="${n.id}">
            <span class="menu-caret">${hasKids ? '›' : ''}</span>
            <span class="menu-label" title="${escapeHtml(n.name)}">${escapeHtml(n.name)}</span>
            <span class="menu-count${cnt ? '' : ' zero'}"${directHint(n)}>${cnt}</span>
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
    // 悬停预取第一页:切过去时命中缓存=秒开(移动端无 hover,靠空闲预取兜底)
    row.addEventListener('mouseenter', () => {
      if (row.dataset.fav) prefetchMenuPage(null, true);
      else if (row.dataset.id) prefetchMenuPage(row.dataset.id, false);
    });
    row.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      const id = row.dataset.id!;
      if (btn) {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (expiryGuard()) return;
        if (act === 'add-child') openMenuModal(id, '');
        else if (act === 'edit-menu') {
          const m = findMenu(MENUS, id);
          openMenuModal(m?.parent_id ?? null, m?.name ?? '', id);
        } else if (act === 'move-menu') openMenuMoveModal(id);
        else if (act === 'del-menu') deleteMenu(id);
        return;
      }
      // 收藏虚拟节点:进入收藏视图(跨菜单、个人)
      if (row.dataset.fav) {
        favView = true;
        // 切视图默认回「全部」筛选:不带着上一个分组的图片/视频/文档过滤进新视图
        typeFilter = '';
        syncTypeFilterUI();
        saveView();
        resetSearch();
        document.querySelectorAll('.menu-row.active').forEach((r) => r.classList.remove('active'));
        row.classList.add('active');
        refreshList().catch((er) => toast((er as Error).message, true));
        // 移动端选中后收起侧栏
        if (window.innerWidth < 1024) toggleSidebarDrawer(false);
        return;
      }
      // 点箭头=仅展开/收起;点行=选中,且若有子菜单则一并展开(免去找小箭头)
      const node = row.parentElement as HTMLElement;
      const caret = (e.target as HTMLElement).closest('.menu-caret');
      const hasKids = !!node.querySelector('.menu-children');
      const isTop = node.classList.contains('menu-depth-1');
      if (isTop && hasKids) {
        // 一级菜单手风琴:打开某个时关闭其余一级;重复点同一个则开合交替
        const wasOpen = node.classList.contains('open');
        document
          .querySelectorAll('.menu-node.menu-depth-1.open')
          .forEach((n) => n.classList.remove('open'));
        node.classList.toggle('open', !wasOpen);
        if (caret) return; // 点箭头只开合,不改变选中
      } else if (caret && hasKids) {
        node.classList.toggle('open');
        return;
      } else if (hasKids) {
        node.classList.add('open');
      }
      // 手风琴补齐:选中任意菜单后,收起所有非其祖先的展开一级菜单。
      // 原来只在点「有子级的一级菜单」分支里收其它组,点叶子菜单(无子集)时旧组会一直敞着
      const ancTop = node.closest('.menu-node.menu-depth-1');
      document.querySelectorAll('.menu-node.menu-depth-1.open').forEach((n) => {
        if (n !== ancTop) n.classList.remove('open');
      });
      selectedMenuId = id;
      favView = false;
      // 切菜单默认回「全部」筛选:不带着上一个分组的图片/视频/文档过滤进新菜单
      typeFilter = '';
      syncTypeFilterUI();
      saveView();
      resetSearch();
      document.querySelectorAll('.menu-row.active').forEach((r) => r.classList.remove('active'));
      row.classList.add('active');
      refreshList().catch((er) => toast((er as Error).message, true));
      // 移动端:点叶子菜单才收起侧栏;点有子级的菜单保持展开,方便继续看手风琴/选子级
      if (window.innerWidth < 1024 && !hasKids) toggleSidebarDrawer(false);
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
            // 到期公司:禁拖拽排序,还原 DOM 并弹续费弹窗
            if (expiryGuard()) {
              renderSidebar();
              return;
            }
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

// ---------------- 菜单 移动到(跨分组/改父级,补拖拽做不到的场景) ----------------
let movingMenuId: string | null = null;
/** 收集某菜单及其所有子孙 id:移动目标需排除这些,防止把父级移进自己的子树(成环) */
function selfAndDescendantIds(id: string): string[] {
  const out: string[] = [];
  const walk = (n: MenuNode) => {
    out.push(n.id);
    n.children.forEach(walk);
  };
  const node = findMenu(MENUS, id);
  if (node) walk(node);
  return out;
}
function openMenuMoveModal(id: string) {
  const node = findMenu(MENUS, id);
  if (!node) return;
  movingMenuId = id;
  const banned = new Set(selfAndDescendantIds(id));
  const sel = $('#menu-move-parent') as HTMLSelectElement;
  sel.innerHTML = [
    `<option value="">顶级(一级菜单)</option>`,
    ...flattenMenus(MENUS)
      .filter((m) => !banned.has(m.id))
      .map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`),
  ].join('');
  sel.value = node.parent_id ?? '';
  const tip = $('#menu-move-tip');
  if (tip) tip.textContent = `把「${node.name}」移动到`;
  openModal('menu-move-modal');
}
async function confirmMenuMove() {
  if (!movingMenuId) return;
  const raw = ($('#menu-move-parent') as HTMLSelectElement).value;
  const parentId = raw ? raw : null;
  // 追加到目标父级末尾:新兄弟数即末尾下标(服务端还会再 clamp 一次)
  const target = parentId ? findMenu(MENUS, parentId) : null;
  const newIndex = parentId
    ? (target?.children ?? []).filter((c) => c.id !== movingMenuId).length
    : MENUS.filter((r) => r.id !== movingMenuId).length;
  try {
    await api('/api/menus/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: movingMenuId, parentId, newIndex }),
    });
    closeModal('menu-move-modal');
    toast('已移动');
    await loadContent();
  } catch (e) {
    toast((e as Error).message, true);
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
  const searching = searchQuery.trim().length > 0;

  if (!searching && !favView && !selectedMenuId) {
    grid.innerHTML = `<div class="empty-hint">${
      isAdmin ? '左侧还没有菜单,点击"新增一级菜单"开始' : '暂无内容'
    }</div>`;
    return;
  }

  // 服务端已按视图(搜索/收藏/菜单子树)过滤+排序+分页;前端只渲染已加载窗口
  const items = ITEMS;

  // 全部类型均可在灯箱内预览:图片/视频/PDF 原生渲染,Word/Excel 由客户端解析渲染
  const previewable = items.filter((it) => TYPE_META[it.type].preview);
  PREVIEW_LIST = previewable.map((it) => ({
    src: it.file_url,
    title: it.title,
    filename: it.filename || '',
    kind: it.type as PreviewItem['kind'],
    id: it.id,
    duration: it.duration,
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
        it.type === 'video'
          ? it.thumb_url || ''
          : it.type === 'image'
            ? it.thumb_url || it.file_url // 卡片挂缩略图;老素材没缩略图时回退原图
            : it.type === 'pdf'
              ? it.thumb_url || '' // PDF 首页预览图(上传时生成/补图通道回补)
              : '';
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
      const thumbInner = previewSrc
        ? `<img src="${previewSrc}"${
            // 图片预览链:缩略图→(缩略图坏)原图→(再坏)占位;onerror 链由 __mmImgErr 驱动
            it.type === 'image' && it.thumb_url ? ` data-fb="${escapeHtml(it.file_url)}"` : ''
          } onerror="window.__mmImgErr && window.__mmImgErr(this)" loading="lazy" decoding="async" />`
        : isMedia
          ? `<div class="text-slate-300 text-xs">无预览</div>`
          : `<div class="doc-icon ${meta.cls}"><i class="fa-solid ${meta.icon}"></i></div>`; // 无预览图的 PDF/Office 回退类型图标
      return `
        <div class="media-card${SELECTED.has(it.id) ? ' picked' : ''}" data-id="${it.id}"${
          pindex !== undefined ? ` data-pindex="${pindex}"` : ''
        }>
          <div class="media-thumb" data-preview="${it.file_url}" data-kind="${
            it.type
          }" data-title="${escapeHtml(it.title)}">
            <span class="card-check"><i class="fa-solid fa-check"></i></span>
            ${thumbInner}
            ${
              it.type !== 'image'
                ? `<span class="type-badge ${meta.cls}"><i class="fa-solid ${
                    it.type === 'video' ? 'fa-play' : meta.icon
                  }"></i>${meta.label}</span>`
                : '' // 图片是无标的默认态:网格更安静,视频/文档一眼跳出
            }
            ${it.type === 'video' ? `<span class="play-badge"><i class="fa-solid fa-play"></i></span>` : ''}
            ${
              it.type === 'video' && it.duration
                ? `<span class="dur-pill">${fmtDuration(it.duration)}</span>`
                : ''
            }
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
  updateGridFooter();

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

// 分享文件缓存:大文件(视频/大图)取回慢,缓存后重试分享无需重新下载;超上限即清空防占内存
const SHARE_FILE_CACHE = new Map<string, File>();
let shareCacheBytes = 0;
const SHARE_CACHE_MAX = 150 * 1024 * 1024;

/** 取素材文件本体并包成 File(单个分享 / 批量分享都要用)。命中缓存直接返回;传 onProgress 可边下边报进度 */
async function fetchItemFile(
  it: ItemDTO,
  onProgress?: (loaded: number, total: number) => void,
): Promise<File> {
  const cached = SHARE_FILE_CACHE.get(it.id);
  if (cached) return cached;

  const res = await fetch(it.file_url);
  if (!res.ok) throw new Error(`「${it.title}」获取失败(${res.status})`);

  const total = Number(res.headers.get('Content-Length') || 0);
  let blob: Blob;
  if (onProgress && res.body && total > 0) {
    // 流式读取,边下边回调(仅在整数百分比变化时触发,避免刷屏)
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    let lastPct = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      loaded += value.length;
      const pct = Math.round((loaded / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        onProgress(loaded, total);
      }
    }
    blob = new Blob(chunks as unknown as BlobPart[], { type: res.headers.get('Content-Type') || MIME_BY_TYPE[it.type] });
  } else {
    blob = await res.blob();
  }

  const file = new File([blob], it.filename || it.title, {
    type: blob.type || MIME_BY_TYPE[it.type],
  });
  if (shareCacheBytes + file.size > SHARE_CACHE_MAX) {
    SHARE_FILE_CACHE.clear();
    shareCacheBytes = 0;
  }
  SHARE_FILE_CACHE.set(it.id, file);
  shareCacheBytes += file.size;
  return file;
}

/** 系统分享:先取文件本体(大文件边下边报进度/预估剩余时间)→ File → 原生分享面板 */
async function shareItemFile(id: string): Promise<void> {
  const it = ITEMS.find((i) => i.id === id);
  if (!it) throw new Error('素材不存在');
  if (!navigator.share)
    throw new Error('当前浏览器不支持分享:可点开大图后长按图片,选择"存储图像/分享"');

  const cached = SHARE_FILE_CACHE.has(it.id);
  if (!cached) toast('正在准备文件…');

  let file: File;
  const t0 = performance.now();
  try {
    file = await fetchItemFile(it, (loaded, total) => {
      const pct = Math.round((loaded / total) * 100);
      const mb = (loaded / 1024 / 1024).toFixed(1);
      const totalMb = (total / 1024 / 1024).toFixed(1);
      // 预估剩余时间:已下载量/已耗时 = 速度,再推剩余秒数
      const elapsed = (performance.now() - t0) / 1000;
      let eta = '';
      if (loaded > 0 && elapsed > 0.3) {
        const remain = Math.max(0, (total - loaded) / (loaded / elapsed));
        eta = remain >= 60 ? `${Math.round(remain / 60)} 分钟` : `${Math.max(1, Math.round(remain))} 秒`;
      }
      toast(`正在下载 ${pct}%(${mb}/${totalMb} MB)${eta ? ` · 约还需 ${eta}` : ''}…`);
    });
  } catch {
    throw new Error('文件获取失败:可点开大图后长按图片,选择"存储图像/分享"');
  }

  try {
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
  } catch (e) {
    // 用户在系统面板里点取消属正常操作,原样抛给调用方静默处理
    if ((e as Error)?.name === 'AbortError') throw e;
    // 大文件下载耗时超过浏览器"用户手势"有效期 → 面板弹不出;文件已缓存,提示再点一次即可秒开
    if (!cached) {
      toast('文件已下载完成,请再点一次「分享」即可弹出面板', false, 6000);
      throw Object.assign(new Error('retry'), { name: 'ShareRetry' });
    }
    throw new Error('分享未唤起:可点开大图后长按图片,选择"存储图像/分享"');
  }
}

// ---------------- 批量选择(逐个下载 / 多文件分享) ----------------
function initBatch() {
  $('#batch-exit')?.addEventListener('click', () => setSelectMode(false));
  $('#batch-all')?.addEventListener('click', togglePickAll);
  $('#batch-download')?.addEventListener('click', () => batchDownload(false));
  $('#batch-zip')?.addEventListener('click', () => batchDownload(true));
  $('#batch-share')?.addEventListener('click', batchShare);
  $('#batch-move')?.addEventListener('click', openBatchMoveModal);
  $('#batch-delete')?.addEventListener('click', batchDelete);
  $('#batch-move-confirm')?.addEventListener('click', batchMove);
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
  const moveLabel = $('#batch-move')?.querySelector('span');
  if (moveLabel) moveLabel.textContent = n > 1 ? `移动 ${n} 个` : '移动';
  const delLabel = $('#batch-delete')?.querySelector('span');
  if (delLabel) delLabel.textContent = n > 1 ? `删除 ${n} 个` : '删除';

  ['#batch-download', '#batch-zip', '#batch-share', '#batch-move', '#batch-delete'].forEach((sel) => {
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
  if (expiryGuard()) return;
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
  if (expiryGuard()) return;
  if (!navigator.share) return toast('当前浏览器不支持分享,请改用下载', true);
  const btn = $('#batch-share') as HTMLButtonElement | null;
  const html = btn?.innerHTML ?? '';
  if (btn) btn.disabled = true;
  try {
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const t0 = performance.now();
      files.push(
        await fetchItemFile(items[i], (loaded, total) => {
          const pct = Math.round((loaded / total) * 100);
          const mb = (loaded / 1024 / 1024).toFixed(1);
          const totalMb = (total / 1024 / 1024).toFixed(1);
          const elapsed = (performance.now() - t0) / 1000;
          let eta = '';
          if (loaded > 0 && elapsed > 0.3) {
            const remain = Math.max(0, (total - loaded) / (loaded / elapsed));
            eta =
              remain >= 60
                ? ` · 约还需 ${Math.round(remain / 60)} 分钟`
                : ` · 约还需 ${Math.max(1, Math.round(remain))} 秒`;
          }
          toast(`正在下载第 ${i + 1}/${items.length} 个:${pct}%(${mb}/${totalMb} MB)${eta}…`);
        }),
      );
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

/** 对勾选素材批量执行操作:逐个调用、按钮显示进度、收集失败项;返回成功数与失败明细 */
async function runBatchOp(
  items: ItemDTO[],
  btn: HTMLButtonElement | null,
  op: (it: ItemDTO) => Promise<unknown>,
): Promise<{ ok: number; failed: { title: string; msg: string }[] }> {
  const html = btn?.innerHTML ?? '';
  if (btn) btn.disabled = true;
  let ok = 0;
  const failed: { title: string; msg: string }[] = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      try {
        await op(it);
        ok++;
      } catch (e) {
        failed.push({ title: it.title || it.filename || '素材', msg: (e as Error).message });
      }
      setBatchProgress(btn, i + 1, items.length);
    }
  } finally {
    // 恢复文案与可点状态:之前只还原 innerHTML,弹窗「移动」确认按钮跑一次后永久灰死,
    // 再开弹窗点击无反应(批量条按钮有 updateBatchBar 兜底,弹窗按钮没有)
    if (btn) {
      btn.innerHTML = html;
      btn.disabled = false;
    }
  }
  return { ok, failed };
}

/** 批量操作结果统一提示:全成功绿色,有失败红色并带首个失败原因 */
function reportBatch(done: string, ok: number, failed: { title: string; msg: string }[]) {
  if (failed.length === 0) toast(`${done} ${ok} 个`);
  else
    toast(
      `${done} ${ok} 个,${failed.length} 个失败:${failed[0].title}(${failed[0].msg})`,
      true,
      4000,
    );
}

/** 批量删除:二次确认 → 逐个调 DELETE(服务端清理 R2 + 数据库)→ 刷新 */
async function batchDelete() {
  if (expiryGuard()) return;
  const items = pickedItems();
  if (!items.length) return toast('请先勾选素材', true);
  if (!confirm(`确定删除所选 ${items.length} 个素材?此操作不可恢复。`)) return;
  const { ok, failed } = await runBatchOp(
    items,
    $('#batch-delete') as HTMLButtonElement | null,
    (it) => api(`/api/items/${it.id}`, { method: 'DELETE' }),
  );
  reportBatch('已删除', ok, failed);
  SELECTED.clear();
  await loadContent();
  updateBatchBar();
}

/** 打开批量移动弹窗:填充分组下拉,若所选同属一个分组则默认选中它 */
function openBatchMoveModal() {
  if (expiryGuard()) return;
  const items = pickedItems();
  if (!items.length) return toast('请先勾选素材', true);
  const sel = $('#batch-move-menu') as HTMLSelectElement;
  sel.innerHTML = flattenMenus(MENUS)
    .map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`)
    .join('');
  const first = items[0].menu_id;
  if (first && items.every((i) => i.menu_id === first)) sel.value = first;
  const tip = $('#batch-move-tip');
  if (tip) tip.textContent = `把 ${items.length} 个素材移动到`;
  // 确认按钮复位:兜底清掉上次批量操作可能残留的灰死/进度态,保证本次打开可点
  const confirmBtn = $('#batch-move-confirm') as HTMLButtonElement | null;
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = '移动';
  }
  openModal('batch-move-modal');
}

/** 批量移动:逐个 PATCH menuId(与单个换分组同一接口)→ 刷新 */
async function batchMove() {
  if (expiryGuard()) return;
  const items = pickedItems();
  if (!items.length) return toast('请先勾选素材', true);
  const menuId = ($('#batch-move-menu') as HTMLSelectElement).value;
  if (!menuId) return toast('请选择目标分组', true);
  const { ok, failed } = await runBatchOp(
    items,
    $('#batch-move-confirm') as HTMLButtonElement | null,
    (it) =>
      api(`/api/items/${it.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menuId }),
      }),
  );
  closeModal('batch-move-modal');
  reportBatch('已移动', ok, failed);
  SELECTED.clear();
  await loadContent();
  updateBatchBar();
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
      if (expiryGuard()) return;
      const url = b.dataset.url!;
      window.location.href = `${url}${url.includes('?') ? '&' : '?'}download=1`;
    });
  });
  // 复制图片(仅图片卡):取原图 → 必要时转 PNG → 写剪贴板
  document.querySelectorAll<HTMLElement>('[data-act="copy-image"]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (expiryGuard()) return;
      const icon = b.querySelector('i');
      const btn = b as HTMLButtonElement;
      // 大图取回要几秒:点击瞬间先给转圈+提示,避免以为没反应/重复点
      btn.disabled = true;
      if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
      toast('正在复制中…');
      try {
        await copyImageToClipboard(b.dataset.url!);
        toast('图片已复制,可直接粘贴');
        if (icon) {
          icon.className = 'fa-solid fa-check';
          window.setTimeout(() => (icon.className = 'fa-regular fa-copy'), 1200);
        }
      } catch (err) {
        if (icon) icon.className = 'fa-regular fa-copy';
        toast((err as Error).message, true);
      } finally {
        btn.disabled = false;
      }
    });
  });
  // 分享(手机端,所有类型):取文件本体调起系统分享面板
  document.querySelectorAll<HTMLElement>('[data-act="share-item"]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (expiryGuard()) return;
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
        // 取消分享 / 大文件下载后需再点一次:都属正常流程,不弹错误(提示已在内部给出)
        const name = (err as Error)?.name;
        if (name !== 'AbortError' && name !== 'ShareRetry')
          toast((err as Error).message || '分享失败', true);
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
      if (expiryGuard()) return;
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
      if (expiryGuard()) return;
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
      FAV_COUNT += on ? 1 : -1;
      paint(on);
      updateFavCount();
      try {
        await api('/api/favorites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId: id, on }),
        });
        // 收藏视图下加/取消收藏会改变卡片列表,重新拉第一页
        if (favView && !searchQuery.trim()) {
          clearPageCache();
          refreshList().catch((er) => toast((er as Error).message, true));
        }
      } catch (err) {
        if (on) FAVORITES.delete(id);
        else FAVORITES.add(id);
        FAV_COUNT += on ? -1 : 1;
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
      if (expiryGuard()) return;
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
          if (expiryGuard()) return;
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
  // 批量模式下也禁用:长按拖拽会和勾选打架;
  // 非叶子菜单(父级视图,混排多个子菜单卡片)与未选菜单(全量视图)同样禁用:
  // 此时 newIndex 按混排列表计算,而 reorder 只作用于 selectedMenuId 单个菜单,
  // 拖拽会把子菜单的卡片改挂到父菜单、且插入位置错乱。叶子菜单视图列表与菜单一一对应,照常可拖。
  const selMenu = selectedMenuId ? findMenu(MENUS, selectedMenuId) : null;
  const leafView = !!selectedMenuId && !(selMenu?.children?.length);
  if (isAdmin && grid && !searchQuery.trim() && !favView && !selectMode && leafView) {
    cardSortable = Sortable.create(grid, {
      animation: 150,
      delay: 250,
      delayOnTouchOnly: true,
      filter: '.add-card, .empty-hint',
      onEnd: async (evt) => {
        // 到期公司:禁拖拽排序,还原 DOM 并弹续费弹窗
        if (expiryGuard()) {
          renderGrid();
          return;
        }
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
  id?: string; // 灯箱惰性回填时长用
  duration?: number | null;
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
    bindPreviewLoading(body, item);
  }
  if (title) {
    title.textContent =
      PREVIEW_LIST.length > 1
        ? `${item.title} · ${previewIndex + 1}/${PREVIEW_LIST.length}`
        : item.title;
  }
  // 手机端提示:长按图片会出系统菜单(存储图像/分享),是进相册的唯一可靠路径
  $('#lb-hint')?.classList.toggle('hidden', !(isMobileViewport() && item.kind === 'image'));
  // 仅一张时隐藏左右切换
  const multi = PREVIEW_LIST.length > 1;
  const prev = $('#lb-prev');
  const next = $('#lb-next');
  if (prev) prev.hidden = !multi;
  if (next) next.hidden = !multi;
}

/** 预览加载动效:大图/大视频加载耗时长,无反馈时用户会以为坏了对退出。
 *  全屏居中 spinner + 文案;视频额外报缓冲百分比、播放卡顿(waiting)时重新显示;
 *  失败转可重试的错误态。Office 预览自带占位,不走这里 */
function bindPreviewLoading(body: HTMLElement, item: PreviewItem) {
  const lb = $('#lightbox');
  lb?.querySelector('.lb-loading')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'lb-loading';
  overlay.innerHTML = '<span class="lb-spinner"></span><span class="lb-loading-text">正在加载…</span>';
  lb?.appendChild(overlay);
  const text = overlay.querySelector('.lb-loading-text') as HTMLElement;
  const hide = () => overlay.classList.add('lb-loading-done');
  const show = (t: string) => {
    text.textContent = t;
    overlay.classList.remove('lb-loading-done');
  };
  const fail = () => {
    overlay.classList.remove('lb-loading-done');
    overlay.classList.add('error');
    overlay.innerHTML =
      '<i class="fa-solid fa-triangle-exclamation"></i><span class="lb-loading-text">加载失败,请检查网络</span><button class="lb-retry-btn" data-act="lb-retry">重试</button>';
  };
  if (item.kind === 'image') {
    const img = body.querySelector('img');
    if (!img) return;
    if (img.complete && img.naturalWidth > 0) hide();
    else {
      img.addEventListener('load', hide, { once: true });
      img.addEventListener('error', fail, { once: true });
    }
  } else if (item.kind === 'video') {
    const v = body.querySelector('video');
    if (!v) return;
    if (v.readyState >= 1) hide();
    v.addEventListener('loadeddata', hide, { once: true });
    // 存量视频时长惰性回填:首次播放拿到 duration 后写回 DB + 列表缓存,卡片下次渲染即带胶囊
    v.addEventListener(
      'loadedmetadata',
      () => {
        const cur = PREVIEW_LIST[previewIndex];
        if (!cur || cur.kind !== 'video' || !cur.id || cur.duration) return;
        if (!isFinite(v.duration) || v.duration <= 0) return;
        const d = Math.round(v.duration * 10) / 10;
        cur.duration = d;
        const row = ITEMS.find((x) => x.id === cur.id);
        if (row && !row.duration) {
          row.duration = d;
          writeListCache();
          renderGrid();
          api(`/api/items/${cur.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ duration: d }),
          }).catch(() => {}); // 回填失败静默:下次播放再试
        }
      },
      { once: true },
    );
    v.addEventListener('canplay', hide);
    v.addEventListener('playing', hide);
    // 播放中卡顿(缓冲跟不上)时重新转出圈,恢复播放再隐去
    v.addEventListener('waiting', () => show('缓冲中…'));
    v.addEventListener('progress', () => {
      if (overlay.classList.contains('lb-loading-done') || overlay.classList.contains('error')) return;
      const buf = v.buffered;
      if (v.duration && buf.length) {
        const p = Math.min(99, Math.floor((buf.end(buf.length - 1) / v.duration) * 100));
        if (p > 0) text.textContent = `缓冲中 ${p}%`;
      }
    });
    v.addEventListener('error', fail, { once: true });
  } else if (item.kind === 'pdf') {
    const f = body.querySelector('iframe');
    if (!f) return;
    f.addEventListener('load', hide, { once: true });
  }
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
  $('#lightbox')?.querySelector('.lb-loading')?.remove();
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
      if (expiryGuard()) return;
      const u = (dlBtn as HTMLElement).dataset.url || '';
      if (u) window.location.href = `${u}${u.includes('?') ? '&' : '?'}download=1`;
      return;
    }
    // 点在媒体/Office 面板/按钮上不关闭
    // 加载失败的重试按钮:重建当前预览触发重新拉流
    if (target.closest('[data-act="lb-retry"]')) {
      e.stopPropagation();
      renderPreview();
      return;
    }
    if (target.closest('img, video, iframe, button, .lb-office, .lb-loading')) return;
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
// 设备默认:PC 10 列 / 手机 3 列;账户已保存的值(users.grid_cols)优先
const COLS_DEFAULT_PC = 10;
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
  // 再兜底:个别浏览器在 load 之后才做凭据自动填充(如把登录用户名填进首屏输入框),延迟复查一次
  window.setTimeout(() => {
    if (input.value && !searchQuery && document.activeElement !== input) {
      input.value = '';
      clearBtn?.classList.add('hidden');
    }
  }, 800);
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
    syncMobileNav();
    refreshList().catch((e) => toast((e as Error).message, true)); // 服务端搜索:拉第一页
  };
  const clear = () => {
    window.clearTimeout(timer);
    resetSearch();
    refreshList().catch((e) => toast((e as Error).message, true));
  };
  input.addEventListener('input', () => {
    // 未聚焦时收到值变化 = 浏览器自动填充/表单恢复(不是用户输入):清掉,不当作搜索词
    if (document.activeElement !== input) {
      input.value = '';
      searchQuery = '';
      clearBtn?.classList.add('hidden');
      return;
    }
    clearBtn?.classList.toggle('hidden', input.value.length === 0);
    // 防抖后走服务端搜索,避免每敲一个字都请求
    window.clearTimeout(timer);
    timer = window.setTimeout(apply, 300);
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
      if (expiryGuard()) return;
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
// 批量上传模式:弹窗改为“逐个上传列表”,保存键变为“完成”(仅关闭)
let batchMode = false;
// 弹窗会话序号:重开弹窗(openItemModal)即作废尚在上传的单文件任务,避免跨弹窗残留
let itemModalSeq = 0;

function openItemModal() {
  if (expiryGuard()) return;
  if (!selectedMenuId) return toast('请先在左侧选择一个菜单', true);
  pendingUpload = null;
  batchMode = false;
  ($('#item-menu-label') as HTMLInputElement).value = menuPath(MENUS, selectedMenuId).join(' › ');
  ($('#item-title') as HTMLInputElement).value = '';
  ($('#file-preview') as HTMLElement).classList.add('hidden');
  ($('#file-preview') as HTMLElement).innerHTML = '';
  // 恢复单文件 UI(批量模式会隐藏标题栏、展开列表面板)
  ($('#item-title') as HTMLElement | null)?.closest('.field')?.classList.remove('hidden');
  ($('#batch-panel') as HTMLElement | null)?.classList.add('hidden');
  const bl = $('#batch-list') as HTMLElement | null;
  if (bl) bl.innerHTML = '';
  const save = $('#item-save') as HTMLButtonElement;
  save.innerHTML = '保存';
  save.disabled = true;
  ($('#upload-status') as HTMLElement).textContent = '';
  ($('#file-input') as HTMLInputElement).value = '';
  // 重置批量面板:后台上传循环以 listEl.dataset.run 认领面板,清空后它们的进度写入自动失效,
  // 既避免旧行残留,也避免旧循环误写新面板的行;itemModalSeq 作废重开时仍在上传的单文件任务
  ($('#batch-panel') as HTMLElement).classList.add('hidden');
  const batchList = $('#batch-list') as HTMLElement;
  batchList.innerHTML = '';
  delete batchList.dataset.run;
  itemModalSeq++;
  openModal('item-modal');
}

/** 上传走 XHR:fetch 拿不到上传进度事件。onProgress(已传字节,总字节) 驱动单文件/批量进度。
 * 超过 CHUNK_THRESHOLD 的文件走分片(uploadFileChunked):Cloudflare 边缘层单请求体上限 100MB,大文件整传会被 413 拒收 */
function uploadFile(
  file: File,
  kind: 'main' | 'thumb',
  onProgress?: (loaded: number, total: number) => void,
): Promise<any> {
  if (file.size > CHUNK_THRESHOLD) return uploadFileChunked(file, kind, onProgress);
  // 连接停滞/网络中断自动重试一次:服务端是纯 R2 写入无副作用,重传安全
  return uploadFileOnce(file, kind, onProgress).catch((e) => {
    if (!isRetryableUploadError(e)) throw e;
    return uploadFileOnce(file, kind, onProgress);
  });
}

/** 停滞看门狗阈值:60s 无进度事件且无响应即认定连接已静默死亡。
 * XHR 默认无超时:字节发完后连接死掉(响应丢失/边缘挂起)时 onload/onerror 都不触发,
 * Promise 永不 settle → 批量行卡 100%、后续队列永久停摆 */
const UPLOAD_STALL_MS = 60_000;
function isRetryableUploadError(e: unknown): boolean {
  return /无响应|网络中断/.test((e as Error)?.message || '');
}

function uploadFileOnce(
  file: File,
  kind: 'main' | 'thumb',
  onProgress?: (loaded: number, total: number) => void,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    // 上传需要带 org 头
    Object.entries(orgHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    let lastAct = Date.now();
    let stalled = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastAct > UPLOAD_STALL_MS) {
        stalled = true;
        clearInterval(watchdog);
        xhr.abort();
      }
    }, 5_000);
    const settle = () => clearInterval(watchdog);
    xhr.upload.onprogress = (e) => {
      lastAct = Date.now();
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      settle();
      let data: any = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `上传失败(HTTP ${xhr.status})`));
    };
    xhr.onerror = () => {
      settle();
      reject(new Error('网络中断:上传失败,请检查网络后重试'));
    };
    xhr.onabort = () => {
      settle();
      reject(new Error(stalled ? '连接无响应(60s 无进度),已中断' : '上传已取消'));
    };
    const fd = new FormData();
    fd.append('file', file);
    fd.append('kind', kind);
    xhr.send(fd);
  });
}

// ---------------- 分片上传(大文件) ----------------
// Cloudflare 边缘层单请求体上限 100MB(Free 计划):大视频传完 100% 才在边缘被 413 拒收。
// 超阈值文件切 10MB 分片逐片传(XHR 原始 body 拿单片进度),服务端 R2 multipart 组装;
// 进度按全文件聚合(已完成片字节 + 当前片已传字节),UI 与单文件上传完全同构。
const CHUNK_THRESHOLD = 50 * 1024 * 1024;
const CHUNK_SIZE = 10 * 1024 * 1024;

/** 传一个分片;失败由调用方重试(同 partNumber 重传幂等,覆盖旧片) */
function uploadChunk(
  url: string,
  blob: Blob,
  onProgress?: (loaded: number) => void,
): Promise<{ partNumber: number; etag: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    Object.entries(orgHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    let lastAct = Date.now();
    let stalled = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastAct > UPLOAD_STALL_MS) {
        stalled = true;
        clearInterval(watchdog);
        xhr.abort();
      }
    }, 5_000);
    xhr.upload.onprogress = (e) => {
      lastAct = Date.now();
      if (e.lengthComputable && onProgress) onProgress(e.loaded);
    };
    xhr.onload = () => {
      clearInterval(watchdog);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
          return;
        } catch {
          /* 落到错误分支 */
        }
      }
      let msg = `分片上传失败(HTTP ${xhr.status})`;
      try {
        msg = JSON.parse(xhr.responseText).error || msg;
      } catch {
        /* 边缘层错误无 JSON,保留状态码文案 */
      }
      reject(new Error(msg));
    };
    xhr.onerror = () => {
      clearInterval(watchdog);
      reject(new Error('网络中断'));
    };
    // 停滞 abort 走这里:调用方的重试循环会同 partNumber 再传一次
    xhr.onabort = () => {
      clearInterval(watchdog);
      reject(new Error(stalled ? '分片连接无响应,已中断' : '分片上传已取消'));
    };
    xhr.send(blob);
  });
}

/** 分片控制面请求(init/complete)加超时上限:fetch 默认无超时,
 * 边缘挂起时会拖住整个批次;超时转可读懂的文案 */
async function apiT<T = any>(url: string, opts: RequestInit = {}, ms = 90_000): Promise<T> {
  try {
    return await api<T>(url, { ...opts, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if ((e as Error)?.name === 'TimeoutError') throw new Error('服务器响应超时,请重试');
    throw e;
  }
}

async function uploadFileChunked(
  file: File,
  kind: 'main' | 'thumb',
  onProgress?: (loaded: number, total: number) => void,
): Promise<any> {
  const mime = file.type || 'application/octet-stream';
  const init = await apiT<{ key: string; uploadId: string }>('/api/upload/mp?step=init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, size: file.size, mime, kind }),
  });
  const qs = `key=${encodeURIComponent(init.key)}&uploadId=${encodeURIComponent(init.uploadId)}`;
  const parts: { partNumber: number; etag: string }[] = [];
  const total = file.size;
  let done = 0;
  try {
    for (let start = 0, n = 1; start < total; start += CHUNK_SIZE, n++) {
      const blob = file.slice(start, Math.min(start + CHUNK_SIZE, total));
      // 单片自动重试一次:网络抖动不必废掉整批进度
      let lastErr: Error | null = null;
      let etag = '';
      for (let attempt = 0; attempt < 2 && !etag; attempt++) {
        try {
          const r = await uploadChunk(
            `/api/upload/mp?step=part&${qs}&partNumber=${n}`,
            blob,
            (loaded) => onProgress?.(done + loaded, total),
          );
          etag = r.etag;
        } catch (e) {
          lastErr = e as Error;
        }
      }
      if (!etag) throw lastErr || new Error('分片上传失败');
      parts.push({ partNumber: n, etag });
      done += blob.size;
      onProgress?.(done, total);
    }
    return await apiT(`/api/upload/mp?step=complete&${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts, name: file.name, mime }),
    });
  } catch (e) {
    // 失败时 best-effort 清理远端分片,不留垃圾 multipart 会话
    apiT(`/api/upload/mp?step=abort&${qs}`, { method: 'POST' }, 30_000).catch(() => {});
    throw e;
  }
}
const fmtMb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
/** 字节人性化:B/KB/MB/GB/TB;≥100 取整,否则一位小数 */
function fmtBytes(n: number): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** 时长胶囊文案:90s → 01:30,超一小时 → 1:05:00 */
function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

/** 读视频时长(秒):上传时随创建入库;失败/超时 resolve(null) 不阻断上传主流程 */
function probeVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    const objUrl = URL.createObjectURL(file);
    video.src = objUrl;
    let settled = false;
    const done = (v: number | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(objUrl);
      resolve(v);
    };
    video.onloadedmetadata = () =>
      done(isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 10) / 10 : null);
    video.onerror = () => done(null);
    window.setTimeout(() => done(null), 8000); // 怪异编码元数据永不返回时的兑底
  });
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

/** PDF 首页渲染成预览图(pdf.js 动态导入按需加载,不进首屏包):
 *  上传时生成缩略图,卡片直接显示内容预览;失败(加密/损坏)返回 null 回退类型图标 */
async function generatePdfThumb(file: File): Promise<Blob | null> {
  try {
    const pdfjs = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const data = new Uint8Array(await file.arrayBuffer());
    const task = pdfjs.getDocument({ data });
    const doc = await task.promise;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 640 / base.width); // 宽限 640px,与图片缩略图同档
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#fff'; // 透明底 PDF 垫白,避免深色模式下透出底色
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport }).promise;
      return await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
    } finally {
      await task.destroy(); // v6:destroy 在 loadingTask 上,释放 worker 与内存
    }
  } catch {
    return null; // 加密/损坏 PDF:不阻断上传,卡片回退类型图标
  }
}

/** 生成图片缩略图:长边缩到 640px 压成 JPEG。卡片列表只加载它,原图仅用于灯箱/复制/分享/下载 */
async function generateImageThumb(file: File): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(file);
    const MAX = 640;
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    // 原图本来就足够小:不造缩略图,省一次上传,卡片直接用原图也不卡
    if (scale === 1 && file.size < 160 * 1024) {
      bmp.close?.();
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bmp.close?.();
      return null;
    }
    // JPEG 无 alpha 通道:先铺白底,避免透明 PNG 缩略后变黑块
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.82);
    });
  } catch {
    // 浏览器解不了的格式(如 HEIC):不造缩略图,卡片回退原图
    return null;
  }
}

/** 苹果 HEIC/HEIF:浏览器(除 Safari)解不了,展示/复制都要靠转码后的 JPEG */
function isHeicName(name: string): boolean {
  return /\.(heic|heif)$/i.test(name || '');
}
/** HEIC → JPEG:先试 heic2any(体积小,覆盖老设备);失败再兜底 libheif-js(见 libheifToJpeg) */
async function heicToJpeg(file: File): Promise<Blob | null> {
  const first = await heic2anyJpeg(file);
  return first ?? (await libheifToJpeg(file));
}
/** 首选:heic2any(动态 import:不传 HEIC 就不下载这个库) */
async function heic2anyJpeg(file: File): Promise<Blob | null> {
  try {
    const heic2any = (await import('heic2any')).default as (
      o: any,
    ) => Promise<Blob | Blob[]>;
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    const b = Array.isArray(out) ? out[0] : out;
    return b || null;
  } catch {
    return null;
  }
}
/** 兜底:libheif-js wasm 预打包(对应较新 libheif,能解 heic2any 那套老 libheif 解不了的新 iPhone 10-bit/HDR HEIC)。
 *  wasm 以 base64 内联,动态 import 按需加载:只有 heic2any 转失败才会下载 */
async function libheifToJpeg(file: File): Promise<Blob | null> {
  try {
    // 包装层在不同环境可能直接给模块对象或 Promise,await 统一归一
    const libheif = await (await import('libheif-js/wasm-bundle')).default;
    const image = new libheif.HeifDecoder().decode(new Uint8Array(await file.arrayBuffer()))[0];
    if (!image) return null;
    const width = image.get_width();
    const height = image.get_height();
    if (!width || !height) return null;
    const raw = document.createElement('canvas');
    raw.width = width;
    raw.height = height;
    const rctx = raw.getContext('2d');
    if (!rctx) return null;
    const data = rctx.createImageData(width, height);
    await new Promise<void>((resolve, reject) => {
      image.display(data, (d) => (d ? resolve() : reject(new Error('HEIF display 失败'))));
    });
    rctx.putImageData(data, 0, 0);
    // JPEG 无 alpha 通道:叠到白底再导出,避免透明区变黑块
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(raw, 0, 0);
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92);
    });
  } catch {
    return null;
  }
}
/** 苹果 HEIC/HEIF 上传前统一转成 JPG:浏览器解不了 HEIC,转完后续全链路走普通图片 */
async function convertHeicIfNeeded(file: File, onStatus?: (s: string) => void): Promise<File> {
  if (!isHeicName(file.name)) return file;
  onStatus?.('HEIC 转码成 JPG 中…');
  const jpeg = await heicToJpeg(file);
  if (!jpeg) throw new Error('HEIC 转码失败:请在手机上导出为 JPEG 后重传');
  return new File([jpeg], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
}
/** 各格式压缩目标:jpg/bmp→JPEG;png/webp→WebP(保留透明);svg(矢量)/gif(动画)不碰 */
const COMPRESS_TARGET: Record<string, { mime: string; ext: string }> = {
  '.jpg': { mime: 'image/jpeg', ext: '.jpg' },
  '.jpeg': { mime: 'image/jpeg', ext: '.jpg' },
  '.bmp': { mime: 'image/jpeg', ext: '.jpg' },
  '.png': { mime: 'image/webp', ext: '.webp' },
  '.webp': { mime: 'image/webp', ext: '.webp' },
};
/** 相机/手机原图常 5-6MB:原尺寸重编码,视觉基本无损;质量阶梯尝试,省不到 10% 才保留原字节 */
async function compressImageIfNeeded(
  file: File,
  onStatus?: (s: string) => void,
): Promise<{ file: File; note: string }> {
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const target = COMPRESS_TARGET[ext];
  if (!target || file.size < 800 * 1024) return { file, note: '' };
  const url = URL.createObjectURL(file);
  try {
    onStatus?.('大图压缩中…(画质基本无损)');
    const img = new Image();
    img.src = url;
    await img.decode(); // 走 <img> 解码:EXIF 旋转会被正确烘焙进像素
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { file, note: '' };
    // JPEG 无 alpha 通道:先铺白底,避免透明区域变黑块
    if (target.mime === 'image/jpeg') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0);
    // 质量阶梯:普通相机图第一档就达标;本身已高效编码的图逐级再试,仍无收益才保留原图
    const ladder = target.mime === 'image/jpeg' ? [0.92, 0.88, 0.84] : [0.95, 0.9, 0.85];
    let best: Blob | null = null;
    for (const q of ladder) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, target.mime, q));
      // 浏览器不支持该编码(如旧 Safari 编 webp)会回退 png:类型不符即放弃
      if (!blob || blob.type !== target.mime) break;
      best = blob;
      if (blob.size < file.size * 0.9) break;
    }
    if (!best || best.size >= file.size * 0.9) return { file, note: '未压缩(已紧凑)' };
    const note = `${fmtMb(file.size)}→${fmtMb(best.size)}`;
    onStatus?.(`已压缩:${note}`);
    return {
      file: new File([best], file.name.replace(/\.[^.]+$/, target.ext), { type: target.mime }),
      note,
    };
  } catch {
    return { file, note: '' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 给无缩略图的老图片/老 PDF 补生成:拉原文件 → 本地生成(图片压缩/PDF 首页渲染) → 上传 → 回写卡片。管理员一次性操作 */
async function backfillThumbs(): Promise<void> {
  if (expiryGuard()) return;
  while (HAS_MORE) await loadMore(); // 分页后先加载全量,再找出缺缩略图的
  const targets = ITEMS.filter((i) => (i.type === 'image' || i.type === 'pdf') && !i.thumb_url);
  if (!targets.length) return toast('当前公司的图片/PDF 都已有缩略图');
  let ok = 0;
  let skip = 0;
  let fail = 0;
  toast(`开始补缩略图:共 ${targets.length} 个…`);
  for (let i = 0; i < targets.length; i++) {
    const it = targets[i];
    try {
      const res = await fetch(it.file_url);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const f = new File([blob], it.filename || it.title, { type: blob.type });
      const thumbBlob = it.type === 'pdf' ? await generatePdfThumb(f) : await generateImageThumb(f);
      // 图片原图已足够小无需缩略图、或 PDF 加密/损坏渲染不出:跳过
      if (!thumbBlob) {
        skip++;
        continue;
      }
      const thumb = await uploadFile(new File([thumbBlob], 'thumb.jpg', { type: 'image/jpeg' }), 'thumb');
      await api(`/api/items/${it.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thumbKey: thumb.key, thumbUrl: thumb.url }),
      });
      it.thumb_url = thumb.url;
      ok++;
    } catch {
      fail++;
    }
    toast(`补缩略图 ${i + 1}/${targets.length}…`);
  }
  renderGrid();
  toast(
    `补缩略图完成:成功 ${ok} 个${skip ? `, ${skip} 个跳过(原图够小或 PDF 无法渲染)` : ''}${fail ? `, ${fail} 个失败` : ''}`,
    fail > 0 && ok === 0,
  );
}

/** 客户端白名单粗筛:最终类型仍由服务端按 mime+扩展名权威判定 */
function isSupportedFile(file: File): boolean {
  const looksMedia = file.type.startsWith('video/') || file.type.startsWith('image/');
  const okExt = /\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|ogv|mov|m4v|pdf|docx?|xlsx?|heic|heif)$/i.test(
    file.name,
  );
  return looksMedia || okExt;
}

async function handleFileChosen(file: File) {
  const status = $('#upload-status') as HTMLElement;
  const preview = $('#file-preview') as HTMLElement;
  if (!isSupportedFile(file)) {
    return toast('仅支持图片、视频、PDF、Word、Excel、HEIC', true);
  }
  const seq = itemModalSeq; // 弹窗会话:上传途中弹窗被重开则结果作废

  ($('#item-save') as HTMLButtonElement).disabled = true;
  try {
    // 苹果 HEIC:上传前先转成 JPG,入库即全平台可看的 JPEG
    let work = await convertHeicIfNeeded(file, (s) => (status.textContent = s));
    // 相机/手机原图太大:视觉基本无损地压一道再传
    const compressed = await compressImageIfNeeded(work, (s) => (status.textContent = s));
    work = compressed.file;
    const main = await uploadFile(work, 'main', (loaded, total) => {
      status.textContent =
        loaded >= total
          ? '上传完成,服务器写入中…'
          : `上传中 ${Math.round((loaded / total) * 100)}%(${fmtMb(loaded)}/${fmtMb(total)})`;
    });
    const type = main.type as ItemType; // 服务端权威判定:image/video/pdf/word/excel
    let thumbKey: string | null = null;
    let thumbUrl: string | null = null;
    let duration: number | null = null;
    if (type === 'video') {
      duration = await probeVideoDuration(work);
      status.textContent = '生成视频缩略图…';
      const blob = await generateVideoThumb(work);
      if (blob) {
        const thumbFile = new File([blob], 'thumb.jpg', { type: 'image/jpeg' });
        const thumb = await uploadFile(thumbFile, 'thumb', (l, t) => {
          status.textContent = `缩略图上传中 ${Math.round((l / t) * 100)}%`;
        });
        thumbKey = thumb.key;
        thumbUrl = thumb.url;
      }
    } else if (type === 'image') {
      status.textContent = '生成图片缩略图…';
      const blob = await generateImageThumb(work);
      if (blob) {
        const thumbFile = new File([blob], 'thumb.jpg', { type: 'image/jpeg' });
        const thumb = await uploadFile(thumbFile, 'thumb', (l, t) => {
          status.textContent = `缩略图上传中 ${Math.round((l / t) * 100)}%`;
        });
        thumbKey = thumb.key;
        thumbUrl = thumb.url;
      }
    } else if (type === 'pdf') {
      status.textContent = '生成 PDF 预览图…';
      const blob = await generatePdfThumb(work);
      if (blob) {
        const thumbFile = new File([blob], 'thumb.jpg', { type: 'image/jpeg' });
        const thumb = await uploadFile(thumbFile, 'thumb', (l, t) => {
          status.textContent = `预览图上传中 ${Math.round((l / t) * 100)}%`;
        });
        thumbKey = thumb.key;
        thumbUrl = thumb.url;
      }
    }
    if (seq !== itemModalSeq) return; // 用户中途关弹窗又重开(=放弃):不把这份上传残留进新弹窗
    pendingUpload = {
      type,
      fileKey: main.key,
      fileUrl: main.url,
      mime: main.mime,
      size: main.size,
      filename: main.filename,
      thumbKey,
      thumbUrl,
      duration,
    };
    // 预览区:图片/视频直接展示,PDF 内嵌,Word/Excel 显示类型图标
    const meta = TYPE_META[type];
    const sizeMb = (work.size / 1024 / 1024).toFixed(1);
    const cap = `<div class="text-xs text-slate-500">${escapeHtml(work.name)}<br/>${meta.label} · ${sizeMb}MB${
      compressed.note ? ` · ${compressed.note}` : ''
    }</div>`;
    preview.classList.remove('hidden');
    if (type === 'image') preview.innerHTML = `<img src="${thumbUrl || main.url}" alt="预览"/>${cap}`;
    else if (type === 'video') preview.innerHTML = `<video src="${main.url}" muted></video>${cap}`;
    else if (type === 'pdf')
      preview.innerHTML = `<iframe class="preview-doc" src="${main.url}" title="PDF 预览"></iframe>${cap}`;
    else
      preview.innerHTML = `<div class="doc-icon ${meta.cls}"><i class="fa-solid ${meta.icon}"></i></div>${cap}`;
    const titleInput = $('#item-title') as HTMLInputElement;
    if (!titleInput.value) titleInput.value = work.name.replace(/\.[^.]+$/, '');
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
        duration: pendingUpload.duration,
      }),
    });
    closeModal('item-modal');
    toast('已添加素材');
    await loadContent();
  } catch (e) {
    toast((e as Error).message, true);
  }
}

/**
 * 批量上传:选择 / 拖入多个文件时走这里。
 * 串行逐个上传(不并发:省手机内存与带宽,也避免服务端瞬时压力)。
 * 去重:同一公司内「文件名 + 大小」已存在即跳过——相机常生成 IMG_0001.jpg 这类同名文件,
 *      只比文件名会误跳,故必须连字节大小一起判断;同一批里选到两次也只传一次。
 */
// 批量上传任务队列:连续选多批时按选择顺序串行执行,目标菜单在选择时锁定(targetMenuId)。
// 两个动机:1) 关弹窗后的后台循环不能被切菜单串改归属;2) 并发循环会争抢同一份弹窗内
// 批量 UI(#batch-list/#upload-status/#item-save),行误写、进度互盖,必须串行。排队批次在选择时提示,前一批完成后自动开始。
let batchQueue: Promise<void> = Promise.resolve();
let batchRunning = false;
let batchRunSeq = 0;

function handleBatchChosen(files: File[]) {
  if (!selectedMenuId) return toast('请先在左侧选择一个菜单', true);
  const targetMenuId = selectedMenuId; // 选择时锁定:之后切菜单不会串改这批的归属
  const queued = batchRunning;
  if (queued) {
    const label = findMenu(MENUS, targetMenuId)?.name ?? '';
    toast(`上一批还在上传,这 ${files.length} 个文件已排队,完成后自动传到「${label}」`);
  }
  batchQueue = batchQueue.then(() =>
    runBatchUpload(files, targetMenuId, queued).catch((e) => toast((e as Error).message || '上传失败', true)),
  );
}

/** 串行执行单元:异常也保证 batchRunning 复位,队列不被单个任务失败弄死 */
async function runBatchUpload(files: File[], targetMenuId: string, queued: boolean) {
  batchRunning = true;
  try {
    await batchUploadTask(files, targetMenuId, queued);
  } finally {
    batchRunning = false;
  }
}

async function batchUploadTask(files: File[], targetMenuId: string, queued: boolean) {
  const runId = ++batchRunSeq;
  const panel = $('#batch-panel') as HTMLElement;
  const listEl = $('#batch-list') as HTMLElement;
  const status = $('#upload-status') as HTMLElement;
  const preview = $('#file-preview') as HTMLElement;
  const saveBtn = $('#item-save') as HTMLButtonElement;
  const titleField = ($('#item-title') as HTMLElement | null)?.closest('.field') as HTMLElement | null;

  // 排队批次只在批量面板还开着(用户正看着上一批结果)时接管 UI;弹窗已关或重开成单文件流程时,
  // 后台静默跑、完成用 toast 汇报,避免破坏当前正在用的界面。
  const ownsUiFromStart = !queued || !panel.classList.contains('hidden');
  if (ownsUiFromStart) {
    batchMode = true;
    // 切到批量 UI:藏起单文件预览与标题输入,展开批量列表
    preview.classList.add('hidden');
    preview.innerHTML = '';
    titleField?.classList.add('hidden');
    panel.classList.remove('hidden');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 上传中…';
  }
  // 进度写入权限:面板仍挂着本 run 的行才写;openItemModal 清掉 dataset.run 后后台循环自动空操作
  const ownsUi = () => listEl.dataset.run === String(runId);
  const say = (t: string) => {
    if (ownsUi()) status.textContent = t;
  };

  // 全公司已存在的「文件名|大小」集合
  const seen = new Set<string>(
    ITEMS.filter((i) => i.filename).map((i) => `${i.filename}|${i.size ?? ''}`),
  );

  type Row = { file: File; state: 'pending' | 'uploading' | 'done' | 'skip' | 'fail'; msg: string };
  const rows: Row[] = [];
  let skipped = 0;
  let unsupported = 0;
  for (const f of files) {
    const key = `${f.name}|${f.size}`;
    if (!isSupportedFile(f)) {
      rows.push({ file: f, state: 'fail', msg: '格式不支持' });
      unsupported++;
    } else if (seen.has(key)) {
      rows.push({ file: f, state: 'skip', msg: '已存在' });
      skipped++;
    } else {
      seen.add(key);
      rows.push({ file: f, state: 'pending', msg: '等待中' });
    }
  }

  const stateText = (r: Row) =>
    r.state === 'uploading'
      ? '上传中…'
      : r.state === 'done'
        ? r.msg
          ? `已新增·${r.msg}`
          : '已新增'
        : r.state === 'skip'
          ? '跳过(重复)'
          : r.state === 'fail'
            ? `失败:${r.msg}`
            : '等待中';

  listEl.innerHTML = rows
    .map(
      (r, i) => `<div class="batch-row" data-idx="${i}">
        <span class="batch-row-name" title="${escapeHtml(r.file.name)}">${escapeHtml(r.file.name)}</span>
        <span class="batch-row-prog"><i data-bar style="width:0%"></i></span>
        <span class="batch-row-state ${r.state}">${stateText(r)}</span>
      </div>`,
    )
    .join('');
  if (ownsUiFromStart) listEl.dataset.run = String(runId);

  const paint = (r: Row, i: number, pct?: number) => {
    if (!ownsUi()) return; // 面板已被新 run 接管 / 被重开弹窗清空:本 run 的写入作废
    const rowEl = listEl.querySelector(`[data-idx="${i}"]`) as HTMLElement | null;
    if (!rowEl) return;
    const el = rowEl.querySelector('.batch-row-state') as HTMLElement | null;
    if (el) {
      // 100% 但未落定 = 服务端还在写入/建缩略图:改文案,避免"卡死在 100%"的误判
      el.textContent =
        pct !== undefined
          ? pct >= 100 && r.state === 'uploading'
            ? '写入中…'
            : `${pct}%`
          : stateText(r);
      el.className = `batch-row-state ${r.state}`;
    }
    const bar = rowEl.querySelector('[data-bar]') as HTMLElement | null;
    if (bar) bar.style.width = `${pct ?? (r.state === 'done' ? 100 : 0)}%`;
  };

  const total = rows.length;
  let ok = 0;
  let errCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.state !== 'pending') continue;
    r.state = 'uploading';
    paint(r, i);
    say(`正在上传 ${i + 1}/${total}:${r.file.name}`);
    try {
      // 苹果 HEIC:上传前先转成 JPG
      let work = await convertHeicIfNeeded(r.file, (s) => {
        say(`${i + 1}/${total}:${s}`);
      });
      // 相机/手机原图太大:视觉基本无损地压一道再传
      const compressed = await compressImageIfNeeded(work, (s) => {
        say(`${i + 1}/${total}:${s}`);
      });
      work = compressed.file;
      // 服务端全量判重(前端只持有已加载页):重复直接跳过,不浪费上传流量
      const dup = await api<{ dup: boolean }>(
        `/api/items?filename=${encodeURIComponent(work.name)}&size=${work.size}`,
      );
      if (dup.dup) {
        r.state = 'skip';
        r.msg = '已存在';
        paint(r, i);
        skipped++;
        continue;
      }
      const main = await uploadFile(work, 'main', (loaded, total) => {
        paint(r, i, Math.round((loaded / total) * 100));
      });
      const type = main.type as ItemType; // 服务端权威判定
      let thumbKey: string | null = null;
      let thumbUrl: string | null = null;
      const duration = type === 'video' ? await probeVideoDuration(work) : null;
      if (type === 'video' || type === 'image' || type === 'pdf') {
        const blob =
          type === 'video'
            ? await generateVideoThumb(work)
            : type === 'image'
              ? await generateImageThumb(work)
              : await generatePdfThumb(work); // PDF 首页预览图
        if (blob) {
          const t = await uploadFile(new File([blob], 'thumb.jpg', { type: 'image/jpeg' }), 'thumb');
          thumbKey = t.key;
          thumbUrl = t.url;
        }
      }
      await api('/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          menuId: targetMenuId,
          type,
          title: work.name.replace(/\.[^.]+$/, ''),
          fileKey: main.key,
          fileUrl: main.url,
          thumbKey,
          thumbUrl,
          mime: main.mime,
          size: main.size,
          filename: main.filename,
          duration,
        }),
      });
      r.state = 'done';
      r.msg = compressed.note;
      ok++;
    } catch (e) {
      r.state = 'fail';
      r.msg = (e as Error).message || '上传失败';
      errCount++;
    }
    paint(r, i);
  }

  const parts: string[] = [];
  if (ok) parts.push(`新增 ${ok} 个`);
  if (skipped) parts.push(`跳过重复 ${skipped} 个`);
  if (unsupported) parts.push(`忽略不支持 ${unsupported} 个`);
  if (errCount) parts.push(`失败 ${errCount} 个`);
  const summary = parts.length ? parts.join(',') : '没有可上传的文件';
  if (ownsUi()) {
    status.textContent = `完成:${summary}`;
    saveBtn.disabled = false;
    saveBtn.innerHTML = '完成';
  }
  toast(`批量上传完成:${summary}`, ok === 0 && errCount + unsupported > 0);
  await loadContent();
}

// ---------------- 存储用量(管理员) ----------------
async function openStorageModal() {
  openModal('storage-modal');
  const list = $('#storage-list') as HTMLElement | null;
  const total = $('#storage-total') as HTMLElement | null;
  if (list)
    list.innerHTML = `<div class="text-sm text-slate-400 py-3"><i class="fa-solid fa-spinner fa-spin"></i> 统计中…</div>`;
  if (total) total.textContent = '';
  try {
    const d = await api<{
      scope: string;
      orgs: { id: string; name: string; bytes: number; count: number }[];
      totalBytes: number;
      totalCount: number;
    }>('/api/admin/storage');
    if (total)
      total.innerHTML =
        d.scope === 'all'
          ? `全部公司合计 <b>${fmtBytes(d.totalBytes)}</b> · ${d.totalCount} 个素材`
          : `本公司已用 <b>${fmtBytes(d.totalBytes)}</b> · ${d.totalCount} 个素材`;
    if (list)
      list.innerHTML = d.orgs.length
        ? d.orgs
            .map(
              (o) => `<div class="list-row">
                <span class="grow">${escapeHtml(o.name)}</span>
                <span class="storage-bytes">${fmtBytes(o.bytes)}</span>
                <span class="storage-count">${o.count} 个</span>
              </div>`,
            )
            .join('')
        : `<div class="text-sm text-slate-400 py-3">暂无数据</div>`;
  } catch (e) {
    if (list)
      list.innerHTML = `<div class="text-sm text-rose-500 py-3">${escapeHtml((e as Error).message)}</div>`;
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
      updateExpiryChip();
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
  if (!activeOrgId && orgs.length) {
    activeOrgId = orgs[0].id;
  }
  if (ME) ME.orgs = orgs; // 同步到期字段,chip 与选项文案读最新值
  renderOrgOptions();
  updateExpiryChip();
}

// ---------------- 会员到期(超管按公司设置) ----------------
/** 到期 chip:超管切换器右侧;点击弹日期选择器设置/清除当前公司到期日,
 *  到期后该公司账号(管理员+普通用户)登录被拒并提示续费 */
function fmtExpiryDate(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function currentOrgExpiry(): number | null {
  return ME?.orgs?.find((o) => o.id === activeOrgId)?.expires_at ?? null;
}
/** 下拉选项文案:公司名 + 各自到期时间,展开下拉不用切换就能逐家看到 */
function orgOptionLabel(o: Org): string {
  const exp = o.expires_at;
  const suffix = !exp
    ? '永久有效'
    : exp < Math.floor(Date.now() / 1000)
      ? `已到期 ${fmtExpiryDate(exp)}`
      : `到期 ${fmtExpiryDate(exp)}`;
  return `${o.name}(${suffix})`;
}
/** 重绘公司下拉选项(保留当前选中);设置到期后也调它刷新文案 */
function renderOrgOptions() {
  const sel = $('#org-switcher') as HTMLSelectElement | null;
  if (!sel || !ME?.orgs) return;
  sel.innerHTML = ME.orgs
    .map((o) => `<option value="${o.id}" ${o.id === activeOrgId ? 'selected' : ''}>${escapeHtml(orgOptionLabel(o))}</option>`)
    .join('');
}
function updateExpiryChip() {
  const chip = $('#org-expiry-chip');
  if (!chip || !isSuper) return;
  // 到期时间已显示在下拉框文案里,chip 专职「点击改到期日」的动作入口;已到期红底警示
  const exp = currentOrgExpiry();
  const expired = !!exp && exp < Math.floor(Date.now() / 1000);
  chip.innerHTML = expired
    ? '<i class="fa-solid fa-triangle-exclamation"></i> 已到期'
    : '<i class="fa-solid fa-calendar-check"></i> 改到期';
  chip.classList.toggle('expired', expired);
}
function initOrgExpiryPicker() {
  const chip = $('#org-expiry-chip');
  const input = $('#org-expiry-input') as HTMLInputElement | null;
  if (!chip || !input) return;
  chip.addEventListener('click', () => {
    const exp = currentOrgExpiry();
    input.value = exp ? fmtExpiryDate(exp) : '';
    // showPicker 的原生弹窗锚定 input 自身盒子:input 常年屏外(left:-9999px),
    // 弹窗会跟着开在屏外,表现为「点了没反应」。开弹前先把 input 挪到 chip 正下方(仍透明)
    const r = chip.getBoundingClientRect();
    input.style.left = `${Math.round(r.left)}px`;
    input.style.top = `${Math.round(r.bottom + 2)}px`;
    input.style.width = `${Math.max(Math.round(r.width), 140)}px`;
    input.style.height = '32px';
    const picker = input as HTMLInputElement & { showPicker?: () => void };
    if (typeof picker.showPicker === 'function') {
      try {
        picker.showPicker();
        return;
      } catch {
        /* 落到内联展示 */
      }
    }
    // 不支持 showPicker 的浏览器:清掉定位样式,输入框内联展示手动选
    input.style.left = input.style.top = input.style.width = input.style.height = '';
    input.classList.add('expiry-input-inline');
    input.focus();
  });
  input.addEventListener('change', async () => {
    const v = input.value; // 'YYYY-MM-DD';空值 = 清除(永久有效)
    const expiresAt = v ? Math.floor(new Date(`${v}T23:59:59`).getTime() / 1000) : null;
    if (!activeOrgId) return;
    try {
      await api(`/api/orgs/${activeOrgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresAt }),
      });
      const o = ME?.orgs?.find((x) => x.id === activeOrgId);
      if (o) o.expires_at = expiresAt;
      toast(expiresAt ? `已设置到期:${v} 当日末` : '已清除到期,永久有效');
      renderOrgOptions();
      updateExpiryChip();
    } catch (e) {
      toast((e as Error).message, true);
    }
    input.classList.remove('expiry-input-inline');
  });
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
  // 菜单移动到(跨分组/改父级)
  $('#menu-move-confirm')?.addEventListener('click', confirmMenuMove);
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
        // 乐观改名:侧栏立即反映,不等后续往返
        const m = findMenu(MENUS, editingMenuId);
        if (m) {
          m.name = name;
          renderSidebar();
        }
      } else {
        const created = await api<{ menu: MenuNode }>('/api/menus', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, parentId: menuParentId }),
        });
        toast('已新增菜单');
        // 乐观插入:新菜单立即进树并渲染,不必等 meta+素材页两次往返
        const node = created?.menu;
        if (node?.id) {
          const withKids: MenuNode = { ...node, children: [] };
          if (withKids.parent_id) {
            const p = findMenu(MENUS, withKids.parent_id);
            if (p) p.children = [...(p.children || []), withKids];
          } else {
            MENUS = [...MENUS, withKids];
          }
          COUNTS[withKids.id] = 0;
          renderSidebar();
          // 展开父级,让新建的子菜单立即可见
          if (withKids.parent_id)
            $('#menu-tree')
              ?.querySelector(`.menu-node[data-id="${withKids.parent_id}"]`)
              ?.classList.add('open');
        }
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
    const files = Array.from(fi.files ?? []);
    if (files.length === 1) handleFileChosen(files[0]);
    else if (files.length > 1) handleBatchChosen(files);
    fi.value = ''; // 清空:下次再选到相同文件也能触发 change
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
    const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
    if (files.length === 1) handleFileChosen(files[0]);
    else if (files.length > 1) handleBatchChosen(files);
  });
  $('#item-save')?.addEventListener('click', () => {
    if (batchMode) {
      batchMode = false;
      ($('#item-save') as HTMLButtonElement).innerHTML = '保存';
      closeModal('item-modal');
    } else {
      saveItem();
    }
  });

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
