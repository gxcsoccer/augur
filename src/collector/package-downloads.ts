/**
 * npm / PyPI 下载量采集
 *
 * 真实使用量比 star 更能反映项目价值。
 */

// ─── npm ─────────────────────────────────────────────────────────

interface NpmDownloads {
  downloads: number;
  start: string;
  end: string;
  package: string;
}

/**
 * 获取 npm 包最近 N 周的周下载量
 */
export async function fetchNpmWeeklyDownloads(
  packageName: string,
  weeks: number = 8,
): Promise<{ week: string; downloads: number }[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - weeks * 7);

  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);

  try {
    const res = await fetch(
      `https://api.npmjs.org/downloads/range/${from}:${to}/${encodeURIComponent(packageName)}`,
    );
    if (!res.ok) return [];

    const data = await res.json() as { downloads: { day: string; downloads: number }[] };

    // Group by week
    const weekMap = new Map<string, number>();
    for (const d of data.downloads) {
      const date = new Date(d.day);
      const day = date.getDay();
      const diff = date.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(date);
      monday.setDate(diff);
      const weekKey = monday.toISOString().slice(0, 10);
      weekMap.set(weekKey, (weekMap.get(weekKey) ?? 0) + d.downloads);
    }

    return [...weekMap.entries()]
      .map(([week, downloads]) => ({ week, downloads }))
      .sort((a, b) => a.week.localeCompare(b.week));
  } catch {
    return [];
  }
}

// ─── PyPI ────────────────────────────────────────────────────────

/**
 * 获取 PyPI 包最近的下载量
 * 使用 pypistats.org API
 */
export async function fetchPyPIDownloads(
  packageName: string,
): Promise<{ week: string; downloads: number }[]> {
  try {
    const res = await fetch(
      `https://pypistats.org/api/packages/${encodeURIComponent(packageName)}/recent?period=week`,
    );
    if (!res.ok) return [];

    const data = await res.json() as { data: { last_week: number } };
    const today = new Date();
    const weekKey = today.toISOString().slice(0, 10);

    return [{ week: weekKey, downloads: data.data.last_week }];
  } catch {
    return [];
  }
}

/**
 * 获取 PyPI 包的月度下载趋势
 */
export async function fetchPyPIMonthlyDownloads(
  packageName: string,
): Promise<{ month: string; downloads: number }[]> {
  try {
    const res = await fetch(
      `https://pypistats.org/api/packages/${encodeURIComponent(packageName)}/overall?mirrors=false`,
    );
    if (!res.ok) return [];

    const data = await res.json() as {
      data: { category: string; date: string; downloads: number }[];
    };

    // Filter to 'without_mirrors' and group by month
    const monthMap = new Map<string, number>();
    for (const d of data.data) {
      if (d.category !== 'without_mirrors') continue;
      const month = d.date.slice(0, 7); // YYYY-MM
      monthMap.set(month, (monthMap.get(month) ?? 0) + d.downloads);
    }

    return [...monthMap.entries()]
      .map(([month, downloads]) => ({ month, downloads }))
      .sort((a, b) => a.month.localeCompare(b.month));
  } catch {
    return [];
  }
}

// ─── 辅助：从 GitHub repo 推断包名 ──────────────────────────────

/**
 * 常见的 repo → package 映射
 * 很多项目的包名和 repo 名不同
 */
const KNOWN_MAPPINGS: Record<string, { npm?: string; pypi?: string }> = {
  'openai/openai-python': { pypi: 'openai' },
  'anthropics/anthropic-sdk-python': { pypi: 'anthropic' },
  'langchain-ai/langchain': { pypi: 'langchain' },
  'langchain-ai/langgraph': { pypi: 'langgraph' },
  'huggingface/transformers': { pypi: 'transformers' },
  'huggingface/huggingface_hub': { pypi: 'huggingface-hub' },
  'chroma-core/chroma': { pypi: 'chromadb' },
  'jerryjliu/llama_index': { pypi: 'llama-index' },
  'run-llama/llama_index': { pypi: 'llama-index' },
  'modelcontextprotocol/python-sdk': { pypi: 'mcp' },
  'modelcontextprotocol/typescript-sdk': { npm: '@modelcontextprotocol/sdk' },
  'browser-use/browser-use': { pypi: 'browser-use' },
  'joaomdmoura/crewAI': { pypi: 'crewai' },
  'microsoft/autogen': { pypi: 'autogen' },
  'tree-sitter/tree-sitter': { npm: 'tree-sitter' },
};

export function guessPackageName(repoId: string, language: string | null): { npm?: string; pypi?: string } {
  // Check known mappings first
  if (KNOWN_MAPPINGS[repoId]) return KNOWN_MAPPINGS[repoId];

  const repoName = repoId.split('/')[1];
  if (!repoName) return {};

  if (language === 'Python') return { pypi: repoName.toLowerCase() };
  if (language === 'TypeScript' || language === 'JavaScript') return { npm: repoName.toLowerCase() };

  return {};
}
