# System Design Domain Knowledge

A comprehensive reference for system design concepts — covering distributed systems, data structures, search engines, geospatial indexing, and more.

Built with [MkDocs](https://www.mkdocs.org/) and the [Material](https://squidfundamentals.github.io/mkdocs-material/) theme.

## Topics

| Section | Pages | Covers |
|---------|-------|--------|
| Transactions | 6 | ACID, isolation levels, locking strategies, flash sale patterns |
| Distributed Systems | 6 | CAP/PACELC, consistency models, consensus algorithms, failure handling |
| Geospatial Search | 8 | Geohash, QuadTrees, H3, S2, space-filling curves, map rendering |
| Search Engine Mechanics | 5 | Inverted indexes, TF-IDF, BM25, Elasticsearch architecture |
| Media Systems | 2 | Video transcoding, file chunking |
| Probabilistic Data Structures | 7 | Bloom filters, Count-Min Sketch, HyperLogLog |

## Local Development

```bash
# Install dependencies
pip install mkdocs-material

# Serve locally
mkdocs serve

# Build static site
mkdocs build
```

The site will be available at `http://127.0.0.1:8000`.

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE) for details.
