import type { ExtensionAPI, ToolExecuteContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { loadEnvFrom } from "./env.ts";

// ---------- constants ----------

const COLLECTION = "ebooks";
const EXCLUDED_PREFIXES = ["教材/", "教辅/"];

// ---------- tool ----------

const qdrantSearchTool = {
  name: "qdrant-search",
  label: "Qdrant Search",
  description:
    "在 Qdrant `ebooks` collection 中做语义/向量检索：先用 bge-m3 把 query 文本转为 1024 维向量，再按 Cosine 相似度检索。" +
    "适合意译、口语化问题、模糊/跨语义匹配（如「黛玉葬花是哪一回」），与 es-search（关键字全文检索）互补。" +
    "内部自动过滤 `教材/` 与 `教辅/` 前缀。format=text 返回可读结果，format=json 返回原始响应。",
  parameters: Type.Object({
    query: Type.String({ description: "自然语言查询（中英文友好，适合意译/模糊描述）", minLength: 1 }),
    limit: Type.Integer({
      description: "返回最相似的结果条数（1~20）",
      default: 8,
      minimum: 1,
      maximum: 20,
    }),
    format: StringEnum(["text", "json"] as const, {
      description: "输出格式：text=可读结果，json=原始响应",
      default: "text",
    }),
  }),
  async execute(
    _toolCallId: string,
    params: { query: string; limit?: number; format?: "text" | "json" },
    _signal: AbortSignal | undefined,
    _onUpdate: ToolExecuteContext["onUpdate"],
    ctx: ToolExecuteContext,
  ) {
    const env = loadEnvFrom(ctx.cwd);
    const url = env.QDRANT_MONKEY_URL;
    const apiKey = env.QDRANT_MONKEY_API_KEY;
    const embedUrl = env.QDRANT_MONKEY_EMBED_URL;
    const embedModel = env.QDRANT_MONKEY_EMBED_MODEL ?? "bge-m3:latest";

    if (!url || !apiKey || !embedUrl) {
      return {
        content: [
          {
            type: "text",
            text:
              "缺少 QDRANT_MONKEY_URL / QDRANT_MONKEY_API_KEY / QDRANT_MONKEY_EMBED_URL。" +
              `工作目录: ${ctx.cwd}（检查 .env）`,
          },
        ],
        details: {},
        isError: true,
      };
    }

    const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);
    const fetchLimit = Math.min(limit * 3, 60);

    // 1. embed query -> 1024-dim vector
    let embedding: number[];
    try {
      const embResp = await fetch(`${embedUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: embedModel, prompt: params.query }),
        signal: _signal,
      });
      if (!embResp.ok) {
        return {
          content: [
            {
              type: "text",
              text: `embedding 请求失败 (${embResp.status}): ${(await embResp.text()).slice(0, 300)}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
      const embData = (await embResp.json()) as { embedding?: number[] };
      embedding = embData.embedding ?? [];
      if (embedding.length === 0) {
        return {
          content: [{ type: "text", text: `embedding 为空：模型 ${embedModel} 未返回向量` }],
          details: {},
          isError: true,
        };
      }
    } catch (e) {
      return {
        content: [
          { type: "text", text: `embedding 调用异常: ${String(e).slice(0, 300)}` },
        ],
        details: {},
        isError: true,
      };
    }

    // 2. search qdrant
    let searchResp: globalThis.Response;
    try {
      searchResp = await fetch(`${url}/collections/${COLLECTION}/points/search`, {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          vector: embedding,
          limit: fetchLimit,
          with_payload: true,
        }),
        signal: _signal,
      });
    } catch (e) {
      return {
        content: [{ type: "text", text: `Qdrant 搜索异常: ${String(e).slice(0, 300)}` }],
        details: {},
        isError: true,
      };
    }

    if (!searchResp.ok) {
      return {
        content: [
          {
            type: "text",
            text: `Qdrant 搜索失败: ${searchResp.status} ${(await searchResp.text()).slice(0, 300)}`,
          },
        ],
        details: {},
        isError: true,
      };
    }

    const data = (await searchResp.json()) as {
      result?: Array<{
        id: string;
        score: number;
        payload?: Record<string, unknown>;
      }>;
    };

    const raw = data.result ?? [];
    const filtered = raw.filter((r) => {
      const bookId = String(r.payload?.book_id ?? "");
      return !EXCLUDED_PREFIXES.some((p) => bookId.startsWith(p));
    }).slice(0, limit);

    if (params.format === "json") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { query: params.query, embeddingDim: embedding.length, result: filtered },
              null,
              2,
            ),
          },
        ],
        details: {},
      };
    }

    if (filtered.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `「${params.query}」语义搜索未命中非教材/教辅结果（请求 ${raw.length} 条，全部被过滤或无结果）。`,
          },
        ],
        details: {},
      };
    }

    const lines: string[] = [];
    lines.push(`「${params.query}」Qdrant 语义搜索 Top ${filtered.length}:`);
    lines.push("");

    for (const r of filtered) {
      const p = r.payload ?? {};
      const bookId = String(p.book_id ?? "?");
      const pageIdx = typeof p.page_idx === "number" ? p.page_idx : Number(p.page_idx ?? 0);
      const chapter = typeof p.chapter === "string" && p.chapter ? p.chapter : undefined;
      const section = typeof p.section === "string" && p.section ? p.section : undefined;
      const text = String(p.text ?? "").replace(/\s+/g, " ").slice(0, 150);
      const tag = section || chapter ? `「${section || chapter}」` : "";
      lines.push(
        `  · [score=${r.score.toFixed(4)}] ${bookId} — 第 ${pageIdx} 页${tag}: ${text}`,
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n").trimEnd() }],
      details: {},
    };
  },
};

// ---------- extension entry ----------

export default function (pi: ExtensionAPI) {
  pi.registerTool(qdrantSearchTool);
}
