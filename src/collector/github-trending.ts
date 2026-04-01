import * as cheerio from 'cheerio';

export interface TrendingRepo {
  id: string;           // 'owner/repo'
  description: string;
  language: string | null;
  starsToday: number;
  totalStars: number;
  forks: number;
  rank: number;
}

const TRENDING_URL = 'https://github.com/trending';

function parseStarCount(text: string): number {
  const cleaned = text.trim().replace(/,/g, '');
  return parseInt(cleaned, 10) || 0;
}

export async function fetchTrending(
  period: 'daily' | 'weekly' | 'monthly' = 'daily',
  language?: string,
): Promise<TrendingRepo[]> {
  const params = new URLSearchParams({ since: period });
  if (language) params.set('spoken_language_code', language);

  const url = `${TRENDING_URL}?${params}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch trending: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  return parseTrendingHtml(html);
}

export function parseTrendingHtml(html: string): TrendingRepo[] {
  const $ = cheerio.load(html);
  const repos: TrendingRepo[] = [];

  $('article.Box-row').each((index, el) => {
    const $el = $(el);

    // repo name: h2 > a href="/owner/repo"
    const repoLink = $el.find('h2 a').attr('href')?.trim();
    if (!repoLink) return;
    const id = repoLink.replace(/^\//, ''); // remove leading slash

    const description = $el.find('p.col-9').text().trim();

    // language
    const langEl = $el.find('[itemprop="programmingLanguage"]');
    const language = langEl.length ? langEl.text().trim() : null;

    // total stars & forks from the inline links
    const inlineLinks = $el.find('.Link--muted.d-inline-block.mr-3');
    let totalStars = 0;
    let forks = 0;
    inlineLinks.each((_, linkEl) => {
      const href = $(linkEl).attr('href') ?? '';
      const val = parseStarCount($(linkEl).text());
      if (href.endsWith('/stargazers')) {
        totalStars = val;
      } else if (href.endsWith('/forks')) {
        forks = val;
      }
    });

    // stars today/this week/this month
    const starsText = $el.find('.float-sm-right, .d-inline-block.float-sm-right').text().trim();
    const starsMatch = starsText.match(/([\d,]+)\s+stars?\s/i);
    const starsToday = starsMatch ? parseStarCount(starsMatch[1]) : 0;

    repos.push({
      id,
      description,
      language,
      starsToday,
      totalStars,
      forks,
      rank: index + 1,
    });
  });

  return repos;
}
