/**
 * GitHub URL/repo 工具函数
 * 所有采集器共享，避免各自实现不一致
 */

const GITHUB_RESERVED_PATHS = new Set([
  'settings', 'orgs', 'organizations', 'features', 'marketplace',
  'explore', 'topics', 'trending', 'collections', 'sponsors',
  'login', 'logout', 'signup', 'join', 'new', 'notifications',
  'issues', 'pulls', 'codespaces', 'apps', 'about', 'pricing',
  'security', 'customer-stories', 'readme', 'enterprise',
  'team', 'contact', 'site', 'github', 'stars',
]);

/**
 * 从 URL 中提取 GitHub repo ID (owner/repo)
 * 返回 null 如果 URL 不是有效的 GitHub repo 链接
 */
export function extractRepoFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/github\.com\/([^/]+\/[^/?#]+)/);
  if (!match) return null;

  const raw = match[1].replace(/\.git$/, '');
  const parts = raw.split('/');
  if (parts.length < 2) return null;

  const owner = parts[0].toLowerCase();
  if (GITHUB_RESERVED_PATHS.has(owner)) return null;

  return `${parts[0]}/${parts[1]}`;
}
