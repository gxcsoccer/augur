/**
 * 共现关键词网络
 *
 * 从 README 提取技术关键词，构建共现矩阵。
 * 同一周内在不同项目中同时出现的关键词对，代表正在形成的技术生态。
 */

import type Database from 'better-sqlite3';

// 技术关键词词典（高精度，避免通用词污染）
const TECH_KEYWORDS = new Set([
  // AI/ML
  'llm', 'rag', 'embedding', 'fine-tuning', 'quantization', 'inference',
  'transformer', 'attention', 'tokenizer', 'gguf', 'ggml', 'onnx',
  'diffusion', 'multimodal', 'vision', 'tts', 'stt', 'whisper',
  // Agent
  'agent', 'multi-agent', 'function-calling', 'tool-use', 'mcp',
  'computer-use', 'browser-use', 'autonomous', 'reasoning', 'chain-of-thought',
  'react', 'reflection', 'planning', 'memory', 'retrieval',
  // Infrastructure
  'vector-database', 'vector-store', 'chromadb', 'pinecone', 'weaviate',
  'langchain', 'llamaindex', 'openai', 'anthropic', 'ollama',
  'vllm', 'tgi', 'mlx', 'cuda', 'metal', 'webgpu',
  // Dev tools
  'cli', 'sdk', 'api', 'rest', 'graphql', 'grpc', 'websocket',
  'lsp', 'tree-sitter', 'ast', 'compiler', 'runtime',
  'docker', 'kubernetes', 'wasm', 'edge', 'serverless',
  // Specific patterns
  'local-ai', 'self-hosted', 'privacy', 'on-device', 'edge-inference',
  'code-generation', 'code-review', 'pair-programming',
  'workflow', 'orchestration', 'pipeline', 'evaluation', 'benchmark',
]);

/**
 * 从文本中提取技术关键词
 */
export function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();

  // Match from keyword dictionary
  for (const kw of TECH_KEYWORDS) {
    // Match whole word or hyphenated form
    const patterns = [kw, kw.replace(/-/g, ' '), kw.replace(/-/g, '')];
    for (const p of patterns) {
      if (lower.includes(p)) {
        found.add(kw);
        break;
      }
    }
  }

  // Extract additional tech terms: capitalized words that look like project/tech names
  const techPatterns = text.match(/\b[A-Z][a-zA-Z]+(?:[-_][A-Z][a-zA-Z]+)+\b/g) ?? [];
  for (const tp of techPatterns) {
    const normalized = tp.toLowerCase();
    if (normalized.length > 3 && normalized.length < 30) {
      found.add(normalized);
    }
  }

  return [...found].sort();
}

export interface CoOccurrenceEntry {
  keyword1: string;
  keyword2: string;
  count: number;
  projects: string[];  // which projects contain both
}

/**
 * 构建共现矩阵：从多个项目的关键词列表中，找出在不同项目中同时出现的关键词对。
 */
export function buildCoOccurrenceMatrix(
  projectKeywords: Map<string, string[]>,
  minCount: number = 2,
): CoOccurrenceEntry[] {
  // keyword -> set of projects containing it
  const keywordProjects = new Map<string, Set<string>>();

  for (const [projectId, keywords] of projectKeywords) {
    for (const kw of keywords) {
      const set = keywordProjects.get(kw) ?? new Set();
      set.add(projectId);
      keywordProjects.set(kw, set);
    }
  }

  // Build co-occurrence pairs
  const pairs = new Map<string, CoOccurrenceEntry>();
  const keywords = [...keywordProjects.keys()];

  for (let i = 0; i < keywords.length; i++) {
    for (let j = i + 1; j < keywords.length; j++) {
      const kw1 = keywords[i] < keywords[j] ? keywords[i] : keywords[j];
      const kw2 = keywords[i] < keywords[j] ? keywords[j] : keywords[i];

      const projects1 = keywordProjects.get(keywords[i])!;
      const projects2 = keywordProjects.get(keywords[j])!;

      // Find projects containing both keywords
      const both = [...projects1].filter(p => projects2.has(p));
      if (both.length >= minCount) {
        const key = `${kw1}::${kw2}`;
        pairs.set(key, {
          keyword1: kw1,
          keyword2: kw2,
          count: both.length,
          projects: both,
        });
      }
    }
  }

  return [...pairs.values()].sort((a, b) => b.count - a.count);
}

/**
 * 从数据库中的 README 构建共现网络并保存
 */
export function analyzeCoOccurrences(db: Database.Database, week: string): CoOccurrenceEntry[] {
  const readmes = db.prepare('SELECT project_id, content FROM readmes').all() as { project_id: string; content: string }[];

  const projectKeywords = new Map<string, string[]>();
  for (const { project_id, content } of readmes) {
    const keywords = extractKeywords(content);
    if (keywords.length > 0) {
      projectKeywords.set(project_id, keywords);

      // Update keywords in readmes table
      db.prepare('UPDATE readmes SET keywords = ? WHERE project_id = ?')
        .run(JSON.stringify(keywords), project_id);
    }
  }

  console.log(`  [CoOccurrence] 从 ${readmes.length} 个 README 中提取关键词`);

  const matrix = buildCoOccurrenceMatrix(projectKeywords);

  // Save to DB
  const insert = db.prepare(`
    INSERT INTO cooccurrences (keyword1, keyword2, week, count, strength, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(keyword1, keyword2, week) DO UPDATE SET
      count = excluded.count,
      strength = excluded.strength
  `);

  const maxCount = matrix.length > 0 ? matrix[0].count : 1;
  for (const entry of matrix) {
    insert.run(
      entry.keyword1,
      entry.keyword2,
      week,
      entry.count,
      entry.count / maxCount, // normalized strength
      week, // first_seen_at
    );
  }

  console.log(`  [CoOccurrence] 发现 ${matrix.length} 个共现关键词对`);
  return matrix;
}

/**
 * 获取本周新出现的共现词对（之前的周没出现过）
 */
export function getNewCoOccurrences(db: Database.Database, week: string): CoOccurrenceEntry[] {
  const rows = db.prepare(`
    SELECT c.keyword1, c.keyword2, c.count, c.strength
    FROM cooccurrences c
    WHERE c.week = ?
      AND NOT EXISTS (
        SELECT 1 FROM cooccurrences prev
        WHERE prev.keyword1 = c.keyword1
          AND prev.keyword2 = c.keyword2
          AND prev.week < c.week
      )
    ORDER BY c.count DESC
  `).all(week) as { keyword1: string; keyword2: string; count: number; strength: number }[];

  return rows.map(r => ({
    keyword1: r.keyword1,
    keyword2: r.keyword2,
    count: r.count,
    projects: [],
  }));
}
