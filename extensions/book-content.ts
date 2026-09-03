import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------- 数据访问（MinIO via mc，本地缓存）----------

const CACHE_ROOT = "/tmp/pi-book-content";

/** mc alias / bucket 可经环境变量覆盖（见 README） */
const MC_ALIAS = process.env.MC_ALIAS ?? "monkey";
const MC_BUCKET = process.env.MC_BUCKET ?? "ebook";
const MC_BASE = `${MC_ALIAS}/${MC_BUCKET}/parsed`;

const FURNITURE = new Set(["page_number", "footer", "header", "page_footnote", "aside_text"]);

function mcCat(path: string): string {
  return execFileSync("mc", ["cat", path], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function sanitize(bookId: string): string {
  return bookId.replace(/\//g, "__");
}

interface PNode {
  title: string;
  node_id: string;
  level: number;
  start_index: number;
  end_index: number;
  summary?: string;
  nodes?: PNode[];
}
interface Pageindex {
  doc_name: string;
  format: number;
  max_page: number;
  structure: PNode[];
}

function cachePath(bookId: string, file: string): string {
  return join(CACHE_ROOT, sanitize(bookId), file);
}

function fetchCached(bookId: string, file: string): string {
  const p = cachePath(bookId, file);
  try {
    return readFileSync(p, "utf8");
  } catch {
    mkdirSync(join(CACHE_ROOT, sanitize(bookId)), { recursive: true });
    const text = mcCat(`${MC_BASE}/${bookId}/${file}`);
    writeFileSync(p, text);
    return text;
  }
}

function loadPageindex(bookId: string): Pageindex {
  const doc = JSON.parse(fetchCached(bookId, "pageindex.json")) as Pageindex;
  if (doc.format !== 4) {
    throw new Error(`${bookId} 的 pageindex 是旧格式（format=${doc.format}），请先用 page-index skill 重建`);
  }
  return doc;
}

function flatNodes(doc: Pageindex): PNode[] {
  const out: PNode[] = [];
  const walk = (nodes: PNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.nodes?.length) walk(n.nodes);
    }
  };
  walk(doc.structure);
  return out;
}

function loadContentList(bookId: string): Array<{ text?: string; type?: string; page_idx?: number }> {
  return JSON.parse(fetchCached(bookId, "content_list.json"));
}

function err(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: {}, isError: true };
}
function ok(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

// ---------- 工具 1: book_structure ----------

const bookStructure = {
  name: "book_structure",
  label: "Book Structure",
  description:
    "获取一本书的结构索引（章节树：标题 / 页码范围 / 摘要）。用于图书问答中判断该加载哪个章节、向相邻/父子章节导航扩展。" +
    "先 es-search / qdrant-search 召回得到 book_id，再用本工具或 book_locate 定位。",
  promptGuidelines: [
    "图书问答标准流程：先用 es-search/qdrant-search 召回片段得到 book_id 和 page_idx → 用 book_locate 把 page_idx 定位到章节 → 用 book_content 加载章节内容并判断是否足以回答 → 不够时用 book_structure 查看相邻/父子章节，继续 book_content 扩展加载，不要盲目重新检索。",
  ],
  parameters: Type.Object({
    book_id: Type.String({ description: "书 id，如 杂书/唐师曾/我钻进了金字塔", minLength: 1 }),
  }),
  async execute(_id: string, params: { book_id: string }) {
    try {
      const doc = loadPageindex(params.book_id);
      const lines = [`${doc.doc_name} — ${doc.max_page + 1} 页（页码为 0 基物理页）`, ""];
      const walk = (nodes: PNode[], depth: number) => {
        for (const n of nodes) {
          const pad = "  ".repeat(depth);
          const sum = n.summary ? ` ─ ${n.summary.slice(0, 80)}` : "";
          lines.push(`${pad}[${n.node_id}] ${n.title} p${n.start_index}-${n.end_index}${sum}`);
          if (n.nodes?.length) walk(n.nodes, depth + 1);
        }
      };
      walk(doc.structure, 0);
      return ok(lines.join("\n"));
    } catch (e) {
      return err(`book_structure 失败: ${(e as Error).message}`);
    }
  },
};

// ---------- 工具 2: book_locate ----------

const bookLocate = {
  name: "book_locate",
  label: "Book Locate",
  description:
    "把物理页码（0 基）定位到所属章节：返回章节链（从顶层到最深层级）及各级标题、页码范围、摘要。" +
    "与 es-search / qdrant-search 配合使用：召回命中 page_idx 后用本工具映射到章节。",
  parameters: Type.Object({
    book_id: Type.String({ description: "书 id", minLength: 1 }),
    page_idx: Type.Integer({ description: "0 基物理页码", minimum: 0 }),
  }),
  async execute(_id: string, params: { book_id: string; page_idx: number }) {
    try {
      const doc = loadPageindex(params.book_id);
      const flat = flatNodes(doc);
      if (!flat.length) return err("pageindex structure 为空");
      let lo = 0, hi = flat.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (flat[mid].start_index <= params.page_idx) { found = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (found < 0) {
        return err(`page ${params.page_idx} 在首个章节（${flat[0].start_index}）之前，属封面/插图区，无章节覆盖`);
      }
      const node = flat[found];
      const chain: PNode[] = [];
      const findPath = (nodes: PNode[], path: PNode[]): boolean => {
        for (const n of nodes) {
          if (n.node_id === node.node_id) { chain.push(...path, n); return true; }
          if (n.nodes?.length && findPath(n.nodes, [...path, n])) return true;
        }
        return false;
      };
      findPath(doc.structure, []);
      const lines = chain.map(
        (n, i) => `${"  ".repeat(i)}[${n.node_id}] ${n.title} p${n.start_index}-${n.end_index}${n.summary ? ` ─ ${n.summary.slice(0, 80)}` : ""}`,
      );
      const parent = chain.length >= 2 ? chain[chain.length - 2] : null;
      const siblings = (parent ? parent.nodes! : doc.structure).filter((n) => n !== node);
      if (siblings.length) {
        lines.push("", "同级章节:");
        for (const s of siblings) lines.push(`  [${s.node_id}] ${s.title} p${s.start_index}-${s.end_index}`);
      }
      return ok(lines.join("\n"), { node_id: node.node_id, start_index: node.start_index, end_index: node.end_index });
    } catch (e) {
      return err(`book_locate 失败: ${(e as Error).message}`);
    }
  },
};

// ---------- 工具 3: book_content ----------

const MAX_SPAN = 40;

const bookContent = {
  name: "book_content",
  label: "Book Content",
  description:
    "加载一本书指定页码范围（0 基物理页，闭区间）的正文文本，来源为 content_list.json（已剔除页眉页脚等版面家具）。" +
    "单次最多 40 页。先 book_locate 得到章节范围，再用本工具加载章节内容。",
  parameters: Type.Object({
    book_id: Type.String({ description: "书 id", minLength: 1 }),
    start_index: Type.Integer({ description: "起始物理页（0 基，含）", minimum: 0 }),
    end_index: Type.Integer({ description: "结束物理页（0 基，含）", minimum: 0 }),
  }),
  async execute(_id: string, params: { book_id: string; start_index: number; end_index: number }) {
    try {
      const { start_index: s, end_index: e } = params;
      if (e < s) return err(`end_index (${e}) < start_index (${s})`);
      if (e - s + 1 > MAX_SPAN) return err(`单次最多 ${MAX_SPAN} 页（请求 ${e - s + 1} 页）。大章节请分段加载`);
      const cl = loadContentList(params.book_id);
      const maxPage = Math.max(...cl.map((it) => it.page_idx ?? 0));
      if (s > maxPage) return err(`start_index ${s} 超出全书最大页 ${maxPage}`);
      const pages: string[] = [];
      for (let p = s; p <= Math.min(e, maxPage); p++) {
        const blocks = cl
          .filter((it) => (it.page_idx ?? 0) === p && typeof it.text === "string" && it.text.trim() && !(it.type && FURNITURE.has(it.type)))
          .map((it) => it.text!.trim());
        pages.push(`[p${p}]\n${blocks.join("\n") || "（本页无文本，可能为图片页）"}`);
      }
      return ok(pages.join("\n\n"), { pages: pages.length });
    } catch (e) {
      return err(`book_content 失败: ${(e as Error).message}`);
    }
  },
};

// ---------- extension entry ----------

export default function (pi: ExtensionAPI) {
  pi.registerTool(bookStructure);
  pi.registerTool(bookLocate);
  pi.registerTool(bookContent);
}
