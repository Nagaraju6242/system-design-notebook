# Advanced Search Patterns

You've deployed Elasticsearch with BM25 scoring and it handles basic keyword search well. But your product manager wants autocomplete that responds in under 50ms, faceted navigation that updates counts instantly as users apply filters, fuzzy matching that catches "iphne" → "iphone", and a search bar that handles both "shoes under $50" and "red nike air max size 10". These aren't basic inverted index lookups — they're search patterns that require specific data structures, query strategies, and architectural decisions.

## Pattern 1: Autocomplete and Search-As-You-Type

### The Problem

A user types "kuber" and expects to see suggestions like "kubernetes", "kubernetes deployment", "kubernetes tutorial" before they finish typing. Latency budget: under 50ms.

### Approach 1: Prefix Queries

The simplest approach — match terms that start with the typed prefix.

```json
{
  "query": {
    "prefix": {
      "title": {
        "value": "kuber"
      }
    }
  }
}
```

Problem: prefix queries on analyzed text fields are slow. Elasticsearch must scan the term dictionary for all terms starting with "kuber". On a large index, this can be expensive.

### Approach 2: Edge N-Grams (The Right Way)

Pre-compute prefixes at index time using an edge n-gram tokenizer:

```json
{
  "settings": {
    "analysis": {
      "analyzer": {
        "autocomplete_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "edge_ngram_filter"]
        }
      },
      "filter": {
        "edge_ngram_filter": {
          "type": "edge_ngram",
          "min_gram": 2,
          "max_gram": 15
        }
      }
    }
  }
}
```

"kubernetes" gets indexed as: `["ku", "kub", "kube", "kuber", "kubern", "kuberne", "kubernet", "kubernete", "kubernetes"]`

Now a search for "kuber" is an exact term lookup — O(1) in the term dictionary, not a prefix scan.

Tradeoff: index size increases 3-5x for autocomplete fields. Use a separate sub-field:

```json
{
  "mappings": {
    "properties": {
      "title": {
        "type": "text",
        "fields": {
          "autocomplete": {
            "type": "text",
            "analyzer": "autocomplete_analyzer",
            "search_analyzer": "standard"
          }
        }
      }
    }
  }
}
```

The `search_analyzer` is `standard` (not edge n-gram) — you don't want to edge-n-gram the query itself, only the indexed terms.

### Approach 3: Completion Suggester

For pure prefix-based suggestions (not full-text search), Elasticsearch's completion suggester uses an in-memory FST (Finite State Transducer) for sub-millisecond lookups:

```json
{
  "suggest": {
    "title-suggest": {
      "prefix": "kuber",
      "completion": {
        "field": "title_suggest",
        "size": 5,
        "fuzzy": {
          "fuzziness": 1
        }
      }
    }
  }
}
```

Tradeoff: the FST lives entirely in heap memory. For millions of unique suggestions, this can consume significant RAM. It also doesn't support full-text relevance scoring — it's purely prefix matching with optional fuzzy tolerance.

## Pattern 2: Fuzzy Matching and Typo Tolerance

### Edit Distance (Levenshtein Distance)

Fuzzy matching finds terms within N edit operations (insert, delete, substitute, transpose) of the query term.

```
"iphne" → "iphone"  (1 transposition: swap 'h' and 'n')
"kuberntes" → "kubernetes" (1 insertion: add 'e')
"pythn" → "python" (1 insertion: add 'o')
```

### Elasticsearch Fuzzy Queries

```json
{
  "query": {
    "fuzzy": {
      "title": {
        "value": "iphne",
        "fuzziness": "AUTO"
      }
    }
  }
}
```

`fuzziness: "AUTO"` scales with term length:
- 0-2 characters: exact match required
- 3-5 characters: 1 edit allowed
- 6+ characters: 2 edits allowed

Under the hood, Elasticsearch builds a Levenshtein automaton and intersects it with the term dictionary. This is efficient but still more expensive than exact lookups.

### Tradeoffs

| Fuzziness | Recall | Precision | Performance |
|---|---|---|---|
| 0 | Low (exact only) | Perfect | Fastest |
| 1 | Good | Good | Moderate |
| 2 | High | Lower (false matches) | Slower |
| AUTO | Balanced | Balanced | Moderate |

Fuzziness 2 on short terms produces garbage: "cat" with fuzziness 2 matches "car", "bat", "cut", "cap", "at", "can", etc. This is why AUTO exists.

## Pattern 3: Faceted Search and Aggregations

### The Problem

An e-commerce sidebar shows: Brand (Nike: 234, Adidas: 189, Puma: 95), Price Range ($0-50: 412, $50-100: 287), Rating (4★+: 523). These counts must update in real-time as the user applies filters.

### How Aggregations Work

Elasticsearch aggregations run alongside the query, computing statistics over the matching document set:

```json
{
  "query": {
    "match": { "description": "running shoes" }
  },
  "aggs": {
    "brands": {
      "terms": { "field": "brand.keyword", "size": 10 }
    },
    "price_ranges": {
      "range": {
        "field": "price",
        "ranges": [
          { "to": 50 },
          { "from": 50, "to": 100 },
          { "from": 100 }
        ]
      }
    },
    "avg_rating": {
      "avg": { "field": "rating" }
    }
  }
}
```

### Doc Values: The Column Store Behind Aggregations

Aggregations don't use the inverted index — they use doc values, a column-oriented data structure stored on disk.

```
Inverted Index (for search):          Doc Values (for aggregations):
  "nike"  → [doc1, doc5, doc9]          doc1 → "nike"
  "adidas" → [doc2, doc3, doc7]         doc2 → "adidas"
                                         doc3 → "adidas"
                                         doc5 → "nike"
```

Doc values are built at index time for all non-text fields. They're memory-mapped and accessed sequentially — efficient for "iterate over all matching docs and count by brand."

### The Post-Filter Pattern

Problem: when a user selects "Nike" as a brand filter, you want the brand facet to still show counts for all brands (so they can switch), but the price and rating facets should reflect only Nike products.

Solution: use `post_filter` for the selected facet, and regular `query` for everything else:

```json
{
  "query": {
    "match": { "description": "running shoes" }
  },
  "aggs": {
    "all_brands": {
      "terms": { "field": "brand.keyword" }
    },
    "filtered_stats": {
      "filter": { "term": { "brand.keyword": "Nike" } },
      "aggs": {
        "price_ranges": {
          "range": { "field": "price", "ranges": [...] }
        }
      }
    }
  },
  "post_filter": {
    "term": { "brand.keyword": "Nike" }
  }
}
```

`post_filter` narrows the search results but doesn't affect aggregations. The `all_brands` aggregation sees all matching docs (not just Nike), while `filtered_stats` explicitly filters to Nike for the other facets.

## Pattern 4: Multi-Field Search with Boosting

### The Problem

A search for "python tutorial" should rank a document titled "Python Tutorial" higher than one where "python tutorial" only appears in the body text. But you also want body matches to contribute to the score.

### dis_max with tie_breaker

```json
{
  "query": {
    "dis_max": {
      "queries": [
        { "match": { "title": { "query": "python tutorial", "boost": 3 } } },
        { "match": { "body": { "query": "python tutorial" } } },
        { "match": { "tags": { "query": "python tutorial", "boost": 2 } } }
      ],
      "tie_breaker": 0.3
    }
  }
}
```

`dis_max` takes the maximum score across fields, then adds `tie_breaker × sum(other field scores)`. This prevents a document matching in all three fields from being dominated by a document with a very high score in just one field.

```
Doc A: title_score=8, body_score=3, tags_score=5
  dis_max = 8 + 0.3 × (3 + 5) = 10.4

Doc B: title_score=9, body_score=0, tags_score=0
  dis_max = 9 + 0.3 × 0 = 9.0
```

Doc A wins because it matches across multiple fields, even though Doc B has a higher title score.

### multi_match Shorthand

```json
{
  "query": {
    "multi_match": {
      "query": "python tutorial",
      "fields": ["title^3", "tags^2", "body"],
      "type": "best_fields",
      "tie_breaker": 0.3
    }
  }
}
```

## Pattern 5: Hybrid Search (Lexical + Semantic)

### The Problem

BM25 can't match "automobile" when the user searches "car". Dense vector embeddings can, but they struggle with exact matches — searching for error code "ERR_0x4F2A" works perfectly with BM25 but poorly with embeddings.

### The Architecture

```
Query: "car maintenance tips"
         │
    ┌────┴────┐
    ▼         ▼
  BM25      kNN Vector Search
  (lexical)  (semantic)
    │         │
    ▼         ▼
  Results A  Results B
    │         │
    └────┬────┘
         ▼
  Reciprocal Rank Fusion (RRF)
         │
         ▼
  Final Merged Results
```

### Reciprocal Rank Fusion (RRF)

RRF merges two ranked lists without needing to normalize scores (BM25 scores and vector similarity scores are on completely different scales):

```
RRF_score(doc) = Σ  1 / (k + rank_i(doc))
                 i

k = 60 (constant, prevents high-ranked docs from dominating too much)
```

Example:
```
BM25 results:   [doc_A (rank 1), doc_B (rank 2), doc_C (rank 3)]
Vector results: [doc_C (rank 1), doc_A (rank 2), doc_D (rank 3)]

doc_A: 1/(60+1) + 1/(60+2) = 0.0164 + 0.0161 = 0.0325
doc_B: 1/(60+2) + 0         = 0.0161
doc_C: 1/(60+3) + 1/(60+1) = 0.0159 + 0.0164 = 0.0323
doc_D: 0         + 1/(60+3) = 0.0159

Final ranking: [doc_A, doc_C, doc_B, doc_D]
```

Doc_A wins because it ranks well in both lists.

### Elasticsearch Implementation

```json
{
  "retriever": {
    "rrf": {
      "retrievers": [
        {
          "standard": {
            "query": {
              "match": { "body": "car maintenance tips" }
            }
          }
        },
        {
          "knn": {
            "field": "body_embedding",
            "query_vector_builder": {
              "text_embedding": {
                "model_id": "my-embedding-model",
                "model_text": "car maintenance tips"
              }
            },
            "k": 50,
            "num_candidates": 100
          }
        }
      ],
      "rank_window_size": 50,
      "rank_constant": 60
    }
  }
}
```

### Tradeoffs

| Approach | Strengths | Weaknesses |
|---|---|---|
| BM25 only | Exact term matching, fast, interpretable | No semantic understanding |
| Vector only | Semantic similarity, handles synonyms | Poor at exact matches, expensive |
| Hybrid (RRF) | Best of both worlds | More complex, higher latency, two indexes to maintain |

## Pattern 6: Query Understanding

### Beyond Raw Keywords

Real search systems don't just pass the raw query to BM25. They process it:

```
User types: "red nike shoes under $50 size 10"
                    │
                    ▼
            Query Understanding
            ├── Entity extraction: brand=Nike, color=red, size=10
            ├── Numeric extraction: price < 50
            ├── Intent classification: product_search
            └── Remaining text: "shoes"
                    │
                    ▼
            Structured Query:
            {
              "bool": {
                "must": { "match": { "title": "shoes" } },
                "filter": [
                  { "term": { "brand": "nike" } },
                  { "term": { "color": "red" } },
                  { "range": { "price": { "lt": 50 } } },
                  { "term": { "size": "10" } }
                ]
              }
            }
```

Filters go in `filter` context (no scoring, cached, fast). Text matching goes in `must` context (scored with BM25). This separation is critical for performance — filters use bitsets that are cached and reused across queries.

## Interview Application

Advanced search patterns demonstrate depth beyond "just use Elasticsearch." Here's how to deploy them:

- "For autocomplete, I'd use edge n-grams at index time — pre-computing prefixes so the search is an exact term lookup, not a prefix scan. This gives sub-10ms response times. For the top-level suggestion dropdown, I'd use the completion suggester backed by an in-memory FST."
- "For typo tolerance, Elasticsearch supports fuzzy queries using Levenshtein automata. I'd use `fuzziness: AUTO` which scales edit distance with term length — preventing short terms from matching too broadly."
- "For faceted navigation, aggregations run alongside the query using doc values — a column-oriented store built at index time. The tricky part is the post-filter pattern: when a user selects a brand filter, the brand facet should still show all brands so they can switch, while other facets reflect the filter."
- "For ranking across multiple fields, I'd use `dis_max` with a `tie_breaker` — take the best field score but give credit for matching in multiple fields. Title gets a 3x boost, tags 2x, body 1x."
- "For semantic search, I'd combine BM25 with vector search in a hybrid approach using reciprocal rank fusion. BM25 handles exact term matching and specific identifiers, vectors handle synonyms and semantic similarity. RRF merges the ranked lists without needing score normalization."

If the interviewer asks about query understanding: "In production, the raw query string goes through a query understanding pipeline — entity extraction, intent classification, numeric parsing — before it becomes an Elasticsearch query. The text portion uses BM25 scoring in a `must` clause, while extracted entities become `filter` clauses that are cached and don't affect scoring."

---

## Related Articles

**Previous in series:** [Elasticsearch Architecture Essentials](elasticsearch-architecture-essentials.md)

**See also:**
- [How to Use HyperLogLog in System Design](../probabilistic/hyperloglog-part-2.md) — cardinality in aggregations