// 租户作用域解析:确定"当前操作针对哪家公司"。
// - 普通用户 / 公司管理员:强制为自身所属 org(忽略任何前端传入,防越权)。
// - 超级管理员:通过请求头 X-Org-Id(或查询参数 orgId)选择要管理的公司。

export const ORG_HEADER = 'x-org-id';

export interface OrgScopeResult {
  orgId: string | null;
  error?: { status: number; message: string };
}

/**
 * 解析当前请求的公司作用域。
 * @param user      已登录用户(来自 locals.user)
 * @param req       当前请求(读取 X-Org-Id 头 / orgId 查询参数)
 * @param validOrg  校验某 orgId 是否存在(用于超级管理员)
 */
export async function resolveOrgScope(
  user: SessionUser | null,
  req: Request,
  validOrg: (orgId: string) => Promise<boolean>,
): Promise<OrgScopeResult> {
  if (!user) return { orgId: null, error: { status: 401, message: '未登录' } };

  // 非超级管理员:作用域固定为自身 org
  if (user.role !== 'superadmin') {
    if (!user.orgId) return { orgId: null, error: { status: 403, message: '账号未绑定公司' } };
    return { orgId: user.orgId };
  }

  // 超级管理员:从请求头或查询参数取目标公司
  const url = new URL(req.url);
  const requested = req.headers.get(ORG_HEADER) || url.searchParams.get('orgId');
  if (!requested) {
    return { orgId: null, error: { status: 400, message: '超级管理员需指定公司(X-Org-Id)' } };
  }
  const ok = await validOrg(requested);
  if (!ok) return { orgId: null, error: { status: 404, message: '公司不存在' } };
  return { orgId: requested };
}

/** 是否为管理员(可编辑内容):超级管理员或公司管理员 */
export function canEdit(user: SessionUser | null): boolean {
  return !!user && (user.role === 'superadmin' || user.role === 'admin');
}

export function isSuperAdmin(user: SessionUser | null): boolean {
  return !!user && user.role === 'superadmin';
}
