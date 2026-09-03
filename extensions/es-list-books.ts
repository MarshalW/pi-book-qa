import type { ExtensionAPI, ToolExecuteContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadEnvFrom } from "./env.ts";

// ---------- tool ----------

const esListBooksTool = {
  name: "es-list-books",
  label: "List Books",
  description:
    "列出 Elasticsearch `ebooks` 索引中的图书（按 book_id 聚合去重）。" +
    "固定排除 `教材/` 与 `教辅/` 前缀。" +
    "format=text 返回可读列表，format=json 返回原始聚合 buckets。",
  parameters: Type.Object({
    format: Type.String({
      description: "输出格式：text=可读列表，json=原始 buckets",
      default: "text",
    }),
  }),
  async execute(
    _toolCallId: string,
    params: { format?: string },
    _signal: AbortSignal | undefined,
    _onUpdate: ToolExecuteContext["onUpdate"],
    ctx: ToolExecuteContext,
  ) {
    const env = loadEnvFrom(ctx.cwd);
    const endpoint = env.ES_ENDPOINT ?? env.ES_MONKEY_ENDPOINT;
    const apiKey = env.ES_API_KEY ?? env.ES_MONKEY_API_KEY;

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

    const EXCLUDED_PREFIXES = ["教材/", "教辅/"];
    const mustNot = EXCLUDED_PREFIXES.map((prefix) => ({
      prefix: { book_id: prefix },
    }));

    const body: Record<string, unknown> = {
      size: 0,
      query: { bool: { must_not: mustNot } },
      aggs: { books: { terms: { field: "book_id", size: 10000 } } },
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
      aggregations?: { books?: { buckets?: Array<{ key: string; doc_count: number }> } };
    };

    const buckets = data?.aggregations?.books?.buckets ?? [];

    if (params.format === "json") {
      return {
        content: [{ type: "text", text: JSON.stringify(buckets, null, 2) }],
        details: {},
      };
    }

    const lines = [
      `图书总数: ${buckets.length}`,
      "",
      ...buckets.map((b) => `${b.key} | 页数: ${b.doc_count}`),
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {},
    };
  },
};

// ---------- extension entry ----------

export default function (pi: ExtensionAPI) {
  pi.registerTool(esListBooksTool);
}
