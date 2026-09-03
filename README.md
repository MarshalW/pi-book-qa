# @marshal/pi-ebook-tools

pi extension for AI-assisted ebook reading. Provides tools for discovering, searching, and reading ebooks stored in MinIO, Elasticsearch, and Qdrant.

## Tools

| Tool | Description |
|------|-------------|
| `es-list-books` | List all books in the Elasticsearch `ebooks` index (excludes configurable prefixes) |
| `es-search` | Full-text keyword search in Elasticsearch with ik Chinese tokenizer |
| `qdrant-search` | Semantic vector search via Qdrant + bge-m3 embedding (Ollama) |
| `book_structure` | Get a book's chapter tree (titles, page ranges, summaries) |
| `book_locate` | Map a physical page number (0-based) to its chapter chain |
| `book_content` | Load book body text for a given page range (up to 40 pages) |

## Prerequisites

- **pi** — installed and working
- **Node.js** — v20+
- **mc** — MinIO CLI, configured with an alias pointing to your MinIO server
- **Ollama** — running with `bge-m3` (or another embedding model, default 1024-dim)
- **Elasticsearch** — an `ebooks` index
- **Qdrant** — an `ebooks` collection (1024-dim Cosine)
- **MinIO** — an `ebook` bucket with parsed book data

## Installation

Install project-locally (recommended, supports per-project version pinning):

```bash
pi install -l npm:@marshal/pi-ebook-tools@0.1.0
```

## Configuration

Place a `.env` file in your project root with the following variables:

```env
# Elasticsearch
ES_ENDPOINT=http://<your-es-host>:9200
ES_API_KEY=<your-api-key>

# Qdrant
QDRANT_URL=http://<your-qdrant-host>:6333
QDRANT_API_KEY=<your-api-key>
QDRANT_EMBED_URL=http://<your-ollama-host>:11434
QDRANT_EMBED_MODEL=bge-m3:latest
```

Legacy variable names (`ES_MONKEY_*`, `QDRANT_MONKEY_*`) are still supported as fallbacks.

MinIO access (used by `book_structure` / `book_locate` / `book_content` via the `mc` CLI) is configured through environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MC_ALIAS` | `minio` | Your `mc` CLI alias for the MinIO server |
| `MC_BUCKET` | `ebook` | Bucket containing parsed book data |

The extension searches for `.env` in the following order:
1. Each directory walking up from the current working directory, until the git root
2. The package root (for a `.env` shipped next to the package)

Works even when pi is launched from a project subdirectory.

> **Note:** launch pi from the project root — pi discovers project-local `.pi/` resources (settings, packages, extensions) relative to the startup directory only.

## Usage

Once installed, the tools are available in pi conversations:

```
# List all books
→ Use es-list-books

# Search for a keyword (e.g., a character name)
→ Use es-search with query "林黛玉"

# Semantic search (e.g., "which chapter has Daiyu burying flowers?")
→ Use qdrant-search with query "黛玉葬花"

# Get book structure
→ Use book_structure with book_id "文学/红楼梦"

# Locate a page
→ Use book_locate with book_id "文学/红楼梦" and page_idx 42

# Read content
→ Use book_content with book_id "文学/红楼梦", start_index 40, end_index 50
```

## Typical Reading Workflow

1. **Discover** — `es-list-books` to see what's available
2. **Search** — `es-search` (exact keyword) or `qdrant-search` (semantic/fuzzy)
3. **Locate** — `book_locate` to map hit page to chapter
4. **Read** — `book_content` to load the actual text
5. **Navigate** — `book_structure` to find adjacent chapters if more context is needed

## Data Contract

- `book_id` is the path under your parsed-data root, e.g. `文学/红楼梦`
- Page numbers are **0-based physical pages**, aligned with `pageindex.json` `start_index`/`end_index`
- `book_content` reads `content_list.json` (layout furniture such as headers/footers already stripped)
- `book_structure` / `book_locate` require `pageindex.json` format 4
- Book ids starting with `教材/` or `教辅/` are excluded from search results by default

## Development

```bash
git clone <this-repo>
cd pi-ebook-tools
pi install ./        # local install for testing
```

## Peer Dependencies

This package declares these as `peerDependencies` (pi provides them at runtime via module aliases, no need to install separately):

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-ai`
- `typebox`
