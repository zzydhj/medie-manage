// 公司 slug 生成:organizations.slug 有 UNIQUE 约束,统一在此处理中文与冲突。

/** 公司名转 slug:保留小写字母数字与中文,其余折叠为连字符;全空时回退时间戳 */
export function slugify(name: string): string {
    return (
        name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
            .replace(/^-+|-+$/g, '') || `org-${Date.now()}`
    );
}

/** 在已占用集合内保证唯一:冲突则追加时间戳 */
export function uniqueSlug(base: string, taken: Set<string>): string {
    const slug = slugify(base);
    return taken.has(slug) ? `${slug}-${Date.now()}` : slug;
}
