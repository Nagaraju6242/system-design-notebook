# TF-IDF Scoring Explained

A user searches "python tutorial" on your learning platform. The inverted index returns 50,000 matching documents. Which ones go on page 1? You can't show them in random order — the user expects the most relevant results first. You need a scoring function that quantifies how relevant each document is to the query. TF-IDF is the foundational algorithm for this, and understanding it is prerequisite to understanding BM25 (which replaced it in modern search engines).

## The Intuition

Two observations drive TF-IDF:

1. **A term that appears frequently in a document is probably important to that document.** If "python" appears 15 times in a blog post, that post is likely about Python.

2. **A term that appears in many documents is less discriminating.** The word "tutorial" appears in 40,000 of your 50,000 results — it doesn't help distinguish good results from bad ones. But "metaclass" appears in only 12 documents — if a document contains "metaclass", that's a strong relevance signal.

TF-IDF combines these two observations into a single score.

## Term Frequency (TF)

Term frequency measures how often a term appears in a specific document.

### Raw TF

The simplest version: just count occurrences.

```
Document: "Python is great. Learn Python today. Python for beginners."
TF("python", doc) = 3
TF("great", doc) = 1
TF("java", doc) = 0
```

Problem: raw counts are unbounded. A 10,000-word document will naturally have higher term counts than a 100-word document, even if both are equally about the topic.

### Log-Normalized TF

Dampen the raw count with a logarithm:

```
tf(t, d) = 1 + log(raw_count)    if raw_count > 0
tf(t, d) = 0                      if raw_count = 0
```

Example:
```
raw_count = 1  → tf = 1 + log(1) = 1.0
raw_count = 2  → tf = 1 + log(2) = 1.69
raw_count = 10 → tf = 1 + log(10) = 3.30
raw_count = 100 → tf = 1 + log(100) = 5.61
```

The 100th occurrence of a term adds far less score than the 1st. This matches intuition — mentioning "python" 100 times doesn't make a document 100x more relevant than one that mentions it once.

### Other TF Variants

| Variant | Formula | Use Case |
|---|---|---|
| Boolean | 1 if present, 0 if not | When you only care about presence |
| Raw count | count(t, d) | Simple but biased toward long docs |
| Log normalization | 1 + log(count) | Most common, good balance |
| Double normalization | 0.5 + 0.5 × (count / max_count_in_doc) | Normalizes across doc lengths |

## Inverse Document Frequency (IDF)

IDF measures how rare or common a term is across the entire corpus.

```
idf(t) = log(N / df(t))

N    = total number of documents in the corpus
df(t) = number of documents containing term t
```

Example with a corpus of 10,000 documents:

```
Term          df      IDF = log(10000/df)
─────────────────────────────────────────
"the"         9800    log(10000/9800) = 0.009
"tutorial"    5000    log(10000/5000) = 0.301
"python"      800     log(10000/800)  = 1.097
"metaclass"   12      log(10000/12)   = 2.921
"coroutine"   3       log(10000/3)    = 3.523
```

"the" has near-zero IDF — it's useless for ranking. "coroutine" has high IDF — finding it in a document is a strong signal.

### The +1 Smoothing Variant

What if a query term doesn't appear in any document? `df(t) = 0` causes division by zero. Common fix:

```
idf(t) = log(N / (1 + df(t))) + 1
```

This is what Elasticsearch's classic TF-IDF implementation uses.

## Combining TF and IDF

The TF-IDF score for a term `t` in document `d`:

```
tfidf(t, d) = tf(t, d) × idf(t)
```

For a multi-term query, sum the TF-IDF scores of each query term:

```
score(query, d) = Σ tfidf(t, d) for each term t in query
```

### Worked Example

Corpus: 10,000 documents. Query: "python metaclass tutorial"

```
Document A (500 words):
  "python" appears 8 times    → tf = 1 + log(8) = 2.90
  "metaclass" appears 5 times → tf = 1 + log(5) = 2.61
  "tutorial" appears 1 time   → tf = 1 + log(1) = 1.00

Document B (200 words):
  "python" appears 3 times    → tf = 1 + log(3) = 2.10
  "metaclass" appears 0 times → tf = 0
  "tutorial" appears 6 times  → tf = 1 + log(6) = 2.79

IDF values (from earlier):
  "python"    = 1.097
  "metaclass" = 2.921
  "tutorial"  = 0.301

Score A = (2.90 × 1.097) + (2.61 × 2.921) + (1.00 × 0.301)
        = 3.18 + 7.62 + 0.30
        = 11.10

Score B = (2.10 × 1.097) + (0 × 2.921) + (2.79 × 0.301)
        = 2.30 + 0 + 0.84
        = 3.14
```

Document A scores 3.5x higher, primarily because it contains "metaclass" — the rare, high-IDF term. Document B mentions "tutorial" 6 times, but that barely moves the needle because "tutorial" has low IDF.

This is the power of IDF: it automatically identifies which query terms are discriminating and weights them accordingly.

## TF-IDF as a Vector Space Model

TF-IDF naturally maps to vector space. Each document becomes a vector in N-dimensional space (where N = vocabulary size), with TF-IDF values as coordinates.

```
Vocabulary: ["python", "java", "tutorial", "metaclass"]

Doc A vector: [3.18, 0, 0.30, 7.62]
Doc B vector: [2.30, 0, 0.84, 0]
Query vector: [1.097, 0, 0.301, 2.921]
```

Relevance = cosine similarity between query vector and document vector:

```
cosine_sim(q, d) = (q · d) / (|q| × |d|)
```

This is the foundation of vector-space information retrieval and directly connects to modern embedding-based search. The difference: TF-IDF vectors are sparse and high-dimensional (vocabulary-sized), while neural embeddings are dense and low-dimensional (768 or 1024 dims).

## Where TF-IDF Falls Short

### No Document Length Normalization

A 10,000-word document naturally accumulates more term occurrences than a 100-word document. TF-IDF with log normalization dampens this but doesn't eliminate it. Long documents get systematically higher scores.

### Linear TF Scaling (Even with Log)

Log normalization helps, but TF-IDF still assumes more occurrences = more relevant, without a saturation point. In practice, a document mentioning "python" 50 times isn't meaningfully more relevant than one mentioning it 10 times. BM25 fixes this with a saturation curve.

### No Term Proximity

TF-IDF treats documents as bags of words. "Python metaclass tutorial" scores the same whether those three words appear in the same sentence or scattered across a 50-page document.

### Static IDF

IDF is computed over the entire corpus at index time. If your corpus changes significantly (new documents added, old ones removed), IDF values become stale. In practice, search engines recompute IDF periodically or per-shard.

## TF-IDF in Practice

### Where It's Still Used

- **Feature extraction for ML**: scikit-learn's `TfidfVectorizer` converts text to feature vectors for classification, clustering
- **Keyword extraction**: terms with highest TF-IDF in a document are its most characteristic keywords
- **Document similarity**: cosine similarity on TF-IDF vectors for deduplication, recommendation
- **Baseline scoring**: before tuning BM25 parameters, TF-IDF gives you a reasonable baseline

### Where It's Been Replaced

- **Search engine ranking**: BM25 replaced TF-IDF as the default in Lucene 6.0+ (2016), Elasticsearch 5.0+
- **Semantic search**: dense vector embeddings (BERT, sentence-transformers) capture meaning, not just term overlap

### Quick Python Example

```python
from sklearn.feature_extraction.text import TfidfVectorizer

corpus = [
    "python metaclass tutorial for beginners",
    "java spring boot tutorial",
    "advanced python metaclass patterns",
    "python web development with django",
]

vectorizer = TfidfVectorizer()
tfidf_matrix = vectorizer.fit_transform(corpus)

# Show terms and their IDF values
for term, idx in sorted(vectorizer.vocabulary_.items()):
    print(f"{term:20s} idf={vectorizer.idf_[idx]:.3f}")
```

## Interview Application

TF-IDF comes up in two interview contexts: designing a search system and designing a recommendation/ML pipeline.

For search system design:
- "The inverted index tells us *which* documents match. TF-IDF tells us *how well* they match. It combines term frequency — how often the term appears in this document — with inverse document frequency — how rare the term is across all documents."
- "The key insight is that IDF automatically down-weights common terms like 'the' or 'tutorial' and up-weights rare, discriminating terms like 'metaclass'. You don't need a manual stopword list for ranking — IDF handles it."
- "In practice, modern search engines use BM25 instead of raw TF-IDF because BM25 adds term frequency saturation and document length normalization. But TF-IDF is the conceptual foundation."

For ML/recommendation design:
- "TF-IDF vectorization converts documents into sparse vectors where each dimension is a vocabulary term. This is a standard feature extraction step before feeding text into classifiers or clustering algorithms."
- "For content-based recommendations, you can compute cosine similarity between TF-IDF vectors of items to find similar content — it's simple, interpretable, and doesn't need training data."

If pushed on limitations: "TF-IDF is a bag-of-words model — it ignores word order and semantics. 'Dog bites man' and 'man bites dog' get the same score. For semantic understanding, you'd layer in dense embeddings from transformer models, but TF-IDF remains valuable as a fast, interpretable baseline."

---

## Related Articles

**Next in series:** [BM25 and Parameter Tuning](bm25-and-parameter-tuning.md)

**Previous in series:** [Inverted Index Fundamentals](inverted-index-fundamentals.md)

**See also:**
- [BM25 and Parameter Tuning](bm25-and-parameter-tuning.md) — the evolution