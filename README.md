# pi-ebook-tools

pi extension for AI-assisted ebook reading. Provides tools for discovering, searching, and reading ebooks stored in MinIO, Elasticsearch, and Qdrant.

## Tools

| Tool | Description |
|------|-------------|
| `es-list-books` | List all books in the Elasticsearch `ebooks` index (excludes 教材/教辅) |
| `es-search` | Full-text keyword search in Elasticsearch with ik Chinese tokenizer |
| `qdrant-search` | Semantic vector search via Qdrant + bge-m3 embedding (Ollama) |
| `book_structure` | Get a book's chapter tree (titles, page ranges, summaries) |
| `book_locate` | Map a physical page number (0-based) to its chapter chain |
| `book_content` | Load book body text for a given page range (up to 40 pages) |

## Prerequisites

- **pi** — installed and working
- **Node.js** — v20+
- **mc** — MinIO CLI, configured with alias `monkey`
- **Ollama** — running with `bge-m3:latest` model (for `qdrant-search`)
- **Elasticsearch** — `ebooks` index accessible at `ES_MONKEY_ENDPOINT`
- **Qdrant** — `ebooks` collection accessible at `QDRANT_MONKEY_URL`
- **MinIO** — `monkey/ebook` bucket accessible via `mc`

## Installation

```bash
pi install npm:pi-ebook-tools
```

Or install from a local path for development:

```bash
pi install /path/to/pi-ebook-tools
```

## Configuration

Place a `.env` file in your project root (or `~/.pi/agent/`) with the following variables:

```env
# Elasticsearch
ES_MONKEY_ENDPOINT=http://monkey:9200
ES_MONKEY_API_KEY=<your-api-key>

# Qdrant
QDRANT_MONKEY_URL=http://monkey:6333
QDRANT_MONKEY_API_KEY=<your-api-key>
QDRANT_MONKEY_EMBED_URL=http://ape:11434
QDRANT_MONKEY_EMBED_MODEL=bge-m3:latest
```

The extension searches for `.env` in the following order:
1. Current working directory (`process.cwd()`)
2. The extension's package root
3. The `extensions/` directory inside the package

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

## Development

```bash
cd pi-ebook-tools
npm install
pi install .   # local install for testing
```

## Peer Dependencies

This package declares these as `peerDependencies` (pi provides them at runtime, no need to install separately):

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-ai`
- `typebox`
