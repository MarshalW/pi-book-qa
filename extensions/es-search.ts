import type { ExtensionAPI, ToolExecuteContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { loadEnvFrom } from "./env.ts";

// ---------- tool ----------

const EXCLUDED_PREFIXES = ["教材/", "教辅/"];

const esSearchTool = {
  name: "es-search",
  label: "ES Search",
  description:
    "在 Elasticsearch `ebooks` 索引中做关键字全文检索（精准匹配）：对正文 `text` 字段使用 ik 中文分词。" +
    "适合已知书名、回目、人名、专有名词等精确查询，与 qdrant-search（语义/向量检索）互补。" +
    "默认排除 `教材/` 与 `教辅/` 前缀。返回按 book_id 聚合的命中页分布及高亮示例片段。",
  parameters: Type.Object({
    query: Type.String({ description: "搜索关键字（书名、回目、人名、专有名词等）", minLength: 1 }),
    size: Type.Integer({
      description: "每本书返回的示例命中页数（1~20）",
      default: 8,
      minimum: 1,
      maximum: 20,
    }),
    format: StringEnum(["text", "json"] as const, {
      description: "输出格式：text=可读聚合结果，json=原始 hits + aggregations",
      default: "text",
    }),
  }),
  async execute(
    _toolCallId: string,
    params: { query: string; size?: number; format?: "text" | "json" },
    _signal: AbortSignal | undefined,
    _onUpdate: ToolExecuteContext["onUpdate"],
    ctx: ToolExecuteContext,
  ) {
    const env = loadEnvFrom(ctx.cwd);
    const endpoint = env.ES_MONKEY_ENDPOINT;
    const apiKey = env.ES_MONKEY_API_KEY;

    if (!endpoint || !apiKey) {
      return {
        content: [
          {
            type: "text",
            text: `缺少 ES_MONKEY_ENDPOINT / ES_MONKEY_API_KEY。工作目录: ${ctx.cwd}（检查 .env）`,
          },
        ],
        details: {},
      };
    }

    const perBook = Math.min(Math.max(params.size ?? 8, 1), 20);
    const hitsSize = Math.min(perBook * 3, 50);

    const body: Record<string, unknown> = {
      size: hitsSize,
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query: params.query,
                fields: ["text"],
              },
            },
          ],
          must_not: EXCLUDED_PREFIXES.map((prefix) => ({
            prefix: { book_id: prefix },
          })),
        },
      },
      highlight: {
        fields: { text: { fragment_size: 120, number_of_fragments: 1 } },
      },
      aggs: {
        by_book: {
          terms: { field: "book_id", size: 20, order: { _count: "desc" } },
        },
      },
    };

    const resp = await fetch(`${endpoint}/ebooks/_search`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: _signal,
    });

    if (!resp.ok) {
      return {
        content: [
          { type: "text", text: `ES 请求失败: ${resp.status} ${await resp.text()}` },
        ],
        details: {},
      };
    }

    const data = (await resp.json()) as {
      hits?: {
        total?: { value?: number };
        hits: Array<{
          _source: Record<string, unknown>;
          highlight?: Record<string, string[]>;
        }>;
      };
      aggregations?: { by_book?: { buckets: Array<{ key: string; doc_count: number }> } };
    };

    const totalHits = data?.hits?.total?.value ?? 0;
    const rawHits = data?.hits?.hits ?? [];
    const bookBuckets = data?.aggregations?.by_book?.buckets ?? [];

    const bookMap = new Map<
      string,
      { count: number; examples: Array<{ page_idx: number; chapter?: string; text: string }> }
    >();
    for (const b of bookBuckets) {
      bookMap.set(b.key, { count: b.doc_count, examples: [] });
    }

    for (const hit of rawHits) {
      const src = hit._source ?? {};
      const bookId = String(src.book_id ?? "");
      if (!bookMap.has(bookId)) continue;
      const entry = bookMap.get(bookId)!;
      if (entry.examples.length >= perBook) continue;

      const snippet = (hit.highlight?.text?.[0] ?? String(src.text ?? "")).replace(/<[^>]+>/g, "");
      const label =
        (typeof src.section === "string" && src.section ? src.section : undefined) ??
        (typeof src.chapter === "string" && src.chapter ? src.chapter : undefined);
      entry.examples.push({
        page_idx: typeof src.page_idx === "number" ? src.page_idx : Number(src.page_idx ?? 0),
        chapter: label,
        text: snippet.slice(0, 200),
      });
    }

    if (params.format === "json") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ totalHits, bookBuckets, hits: rawHits }, null, 2),
          },
        ],
        details: {},
      };
    }

    const lines: string[] = [];
    lines.push(`「${params.query}」命中 ${bookBuckets.length} 本书 / ${totalHits} 页`);
    lines.push("");

    for (const book of bookBuckets) {
      const entry = bookMap.get(book.key)!;
      lines.push(`${book.key} — ${book.doc_count} 页`);
      for (const ex of entry.examples) {
        const chapterTag = ex.chapter ? `「${ex.chapter}」` : "";
        lines.push(`  · 第 ${ex.page_idx} 页${chapterTag}: ${ex.text}`);
      }
      if (book.doc_count > entry.examples.length) {
        lines.push(`  · … 还有 ${book.doc_count - entry.examples.length} 页`);
      }
      lines.push("");
    }

    return {
      content: [{ type: "text", text: lines.join("\n").trimEnd() }],
      details: {},
    };
  },
};

// ---------- extension entry ----------

export default function (pi: ExtensionAPI) {
  pi.registerTool(esSearchTool);
}
