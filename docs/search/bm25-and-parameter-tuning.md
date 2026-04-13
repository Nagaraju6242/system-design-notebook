# BM25 and Parameter Tuning

You've built a search system using TF-IDF and it mostly works. But you notice a pattern: long Wikipedia-style articles consistently outrank short, focused answers. A 5,000-word article mentioning "kubernetes deployment" 30 times scores higher than a concise 200-word guide that mentions it 5 times — even though the short guide is exactly what the user wants. TF-IDF's log normalization isn't enough. You need a scoring function that handles document length properly and has a saturation point for term frequency. That function is BM25, and it's been the default ranking algorithm in Lucene, Elasticsearch, and Solr since 2016.

## From TF-IDF to BM25

BM25 (Best Matching 25) evolved from probabilistic information retrieval research in the 1990s. It addresses two specific weaknesses of TF-IDF:

1. **Term frequency doesn't saturate.** In TF-IDF, even with log normalization, more occurrences always means a higher score. BM25 introduces a saturation curve — after a certain point, additional occurrences barely increase the score.

2. **No explicit document length normalization.** TF-IDF doesn't account for the fact that a term appearing 10 times in a 100-word document is more significant than 10 times in a 10,000-word document. BM25 normalizes against average document length.

## The BM25 Formula

For a query Q containing terms q₁, q₂, ..., qₙ, the BM25 score of a document D is:

```
score(D, Q) = Σ IDF(qᵢ) × [ f(qᵢ, D) × (k1 + 1) ] / [ f(qᵢ, D) + k1 × (1 - b + b × |D|/avgdl) ]
```

Where:
- `f(qᵢ, D)` = raw term frequency of qᵢ in document D
- `|D|` = length of document D (in terms)
- `avgdl` = average document length across the corpus
- `k1` = term frequency saturation parameter (default: 1.2)
- `b` = document length normalization parameter (default: 0.75)

The IDF component in BM25 (Lucene's variant):

```
IDF(q) = log(1 + (N - df(q) + 0.5) / (df(q) + 0.5))
```

This looks complex. Let's break it apart.

## Understanding Each Component

### The TF Saturation Curve

The core TF component of BM25:

```
tf_component = [f × (k1 + 1)] / [f + k1 × norm]
```

Where `norm = 1 - b + b × (|D| / avgdl)` (we'll cover this next).

Ignoring length normalization for a moment (set norm = 1):

```
f=1:   (1 × 2.2) / (1 + 1.2) = 1.0
f=2:   (2 × 2.2) / (2 + 1.2) = 1.375
f=5:   (5 × 2.2) / (5 + 1.2) = 1.774
f=10:  (10 × 2.2) / (10 + 1.2) = 1.964
f=50:  (50 × 2.2) / (50 + 1.2) = 2.147
f=100: (100 × 2.2) / (100 + 1.2) = 2.174
```

The score approaches but never exceeds `(k1 + 1) = 2.2`. Going from 1 to 2 occurrences gives +0.375. Going from 50 to 100 gives +0.027. This is the saturation effect — it matches the intuition that the 50th mention of a term adds almost no relevance signal.

```
Score
  ^
  |                          _______________  ← asymptote at (k1+1)
  |                    _____/
  |               ____/
  |          ____/
  |     ____/
  |   _/
  |  /
  | /
  |/
  +──────────────────────────────────────→ Term Frequency
  0    5    10   15   20   25   30
```

### The k1 Parameter: Controlling Saturation Speed

`k1` controls how quickly the TF component saturates:

```
k1 = 0:   TF component = 1 for any f > 0 (binary: present or not)
k1 = 0.5: Saturates quickly — 5 occurrences ≈ max effect
k1 = 1.2: Default — moderate saturation (good general-purpose)
k1 = 2.0: Saturates slowly — term frequency matters more
k1 = ∞:   No saturation — approaches raw TF (like TF-IDF)
```

Concrete comparison at f=5:

```
k1=0.5:  (5 × 1.5) / (5 + 0.5) = 1.36  (already 91% of max 1.5)
k1=1.2:  (5 × 2.2) / (5 + 1.2) = 1.77  (81% of max 2.2)
k1=2.0:  (5 × 3.0) / (5 + 2.0) = 2.14  (71% of max 3.0)
```

**When to increase k1:** Your documents are long and term frequency is a meaningful signal (academic papers, legal documents). **When to decrease k1:** Short documents where presence matters more than count (tweets, product titles).

### The b Parameter: Document Length Normalization

The length normalization factor:

```
norm = 1 - b + b × (|D| / avgdl)
```

This scales the effective TF based on how long the document is relative to average.

```
b = 0:   norm = 1 always. No length normalization. Long and short docs treated equally.
b = 1:   norm = |D|/avgdl. Full length normalization. A doc 2x average length has its TF halved.
b = 0.75: Default. Partial normalization — long docs are penalized but not as aggressively.
```

Example with avgdl = 500 words:

```
Document length: 100 words (short)
  b=0:    norm = 1.0
  b=0.75: norm = 1 - 0.75 + 0.75 × (100/500) = 0.40
  b=1:    norm = 100/500 = 0.20

Document length: 2000 words (long)
  b=0:    norm = 1.0
  b=0.75: norm = 1 - 0.75 + 0.75 × (2000/500) = 3.25
  b=1:    norm = 2000/500 = 4.0
```

A short document (100 words) with b=0.75 gets norm=0.40, which *boosts* its TF component (dividing by a smaller number). A long document (2000 words) gets norm=3.25, which *penalizes* its TF component.

**When to increase b:** Documents vary widely in length and long documents shouldn't dominate (web search, mixed-content indexes). **When to decrease b:** Document length is meaningful — longer documents genuinely contain more information (academic search, book search).

### The IDF Component

BM25's IDF in Lucene:

```
IDF(q) = log(1 + (N - df + 0.5) / (df + 0.5))
```

This is similar to classic IDF but with smoothing. For a corpus of 10,000 docs:

```
df=1:     log(1 + 9999.5/1.5) = log(6667) = 8.80
df=100:   log(1 + 9900.5/100.5) = log(99.5) = 4.60
df=5000:  log(1 + 5000.5/5000.5) = log(2) = 0.69
df=9999:  log(1 + 1.5/9999.5) = log(1.0002) ≈ 0.0002
```

Terms appearing in nearly every document contribute almost nothing to the score.

## Worked Example: Full BM25 Scoring

Corpus: N=10,000 documents, avgdl=500 words. k1=1.2, b=0.75.

Query: "kubernetes deployment strategies"

Document A: 300 words
- "kubernetes": f=5, df=800
- "deployment": f=3, df=2000
- "strategies": f=2, df=500

Document B: 1500 words
- "kubernetes": f=15, df=800
- "deployment": f=10, df=2000
- "strategies": f=0, df=500

```
IDF values:
  "kubernetes": log(1 + (10000-800+0.5)/(800+0.5)) = log(1 + 11.49) = 2.52
  "deployment": log(1 + (10000-2000+0.5)/(2000+0.5)) = log(1 + 4.00) = 1.61
  "strategies": log(1 + (10000-500+0.5)/(500+0.5)) = log(1 + 18.99) = 3.00

Document A (300 words):
  norm = 1 - 0.75 + 0.75 × (300/500) = 0.70

  "kubernetes": 2.52 × (5×2.2)/(5 + 1.2×0.70) = 2.52 × 11/5.84 = 2.52 × 1.88 = 4.74
  "deployment": 1.61 × (3×2.2)/(3 + 1.2×0.70) = 1.61 × 6.6/3.84 = 1.61 × 1.72 = 2.77
  "strategies": 3.00 × (2×2.2)/(2 + 1.2×0.70) = 3.00 × 4.4/2.84 = 3.00 × 1.55 = 4.65

  Total: 4.74 + 2.77 + 4.65 = 12.16

Document B (1500 words):
  norm = 1 - 0.75 + 0.75 × (1500/500) = 2.50

  "kubernetes": 2.52 × (15×2.2)/(15 + 1.2×2.50) = 2.52 × 33/18 = 2.52 × 1.83 = 4.61
  "deployment": 1.61 × (10×2.2)/(10 + 1.2×2.50) = 1.61 × 22/13 = 1.61 × 1.69 = 2.72
  "strategies": 3.00 × 0 = 0

  Total: 4.61 + 2.72 + 0 = 7.33
```

Document A wins (12.16 vs 7.33) despite having fewer raw term occurrences. Two factors:
1. Length normalization: A is shorter than average, B is 3x average
2. Document A contains "strategies" (high IDF term), B doesn't

## Parameter Tuning in Practice

### Default Values Work Surprisingly Well

Elasticsearch defaults (k1=1.2, b=0.75) are solid for most use cases. Don't tune unless you have evidence of a problem.

### When to Tune

| Symptom | Likely Fix |
|---|---|
| Long documents always rank first | Increase b (more length penalty) |
| Short documents always rank first | Decrease b (less length penalty) |
| Keyword-stuffed docs rank too high | Decrease k1 (faster saturation) |
| Rare term mentions don't rank high enough | Increase k1 (slower saturation) |

### How to Tune

1. Build a test set of queries with known-good results (relevance judgments)
2. Measure ranking quality with NDCG@10 or MAP
3. Grid search over k1 ∈ [0.5, 2.0] and b ∈ [0.0, 1.0]
4. Validate on a held-out test set

### Elasticsearch Configuration

```json
PUT /my_index
{
  "settings": {
    "index": {
      "similarity": {
        "custom_bm25": {
          "type": "BM25",
          "k1": "1.5",
          "b": "0.5"
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "title": {
        "type": "text",
        "similarity": "custom_bm25"
      }
    }
  }
}
```

You can set different BM25 parameters per field — title fields often benefit from lower b (titles are naturally short, length variation is noise) and lower k1 (one mention in a title is enough).

## BM25 Variants

### BM25F (Field-Weighted)

Real documents have multiple fields (title, body, tags). BM25F combines field-level term frequencies with per-field weights and length normalization before computing the score, rather than scoring each field independently and summing.

```
tf_combined = w_title × tf_title/norm_title + w_body × tf_body/norm_body + w_tags × tf_tags/norm_tags
```

This is more principled than Elasticsearch's default approach of scoring each field separately and taking the max (`dis_max`) or sum.

### BM25+

Standard BM25 can assign a score of 0 to a document that contains a query term if the document is very long (the length penalty overwhelms the TF signal). BM25+ adds a small constant δ (typically 1) to the TF component to ensure any matching document scores above zero.

## Interview Application

BM25 is the answer whenever an interviewer asks "how do you rank search results?" Here's how to present it:

- "For text ranking, I'd use BM25 — it's the industry standard, used by Elasticsearch, Solr, and Lucene by default. It improves on TF-IDF in two ways: term frequency saturates (the 50th mention of a word barely increases the score), and document length is explicitly normalized against the corpus average."
- "BM25 has two tunable parameters: k1 controls how quickly term frequency saturates — lower values mean presence matters more than count. b controls document length normalization — higher values penalize long documents more. Defaults of k1=1.2 and b=0.75 work well for most cases."
- "For multi-field documents, I'd use different BM25 parameters per field. Title matches with k1=0.5, b=0.25 — because titles are short and one mention is sufficient. Body matches with default parameters."

If the interviewer asks about going beyond BM25: "BM25 handles lexical matching — it can't understand that 'automobile' and 'car' are related. For semantic search, I'd combine BM25 with dense vector embeddings in a hybrid approach: BM25 for precision on exact terms, embeddings for recall on semantic similarity, then merge the ranked lists with reciprocal rank fusion."

---

## Related Articles

**Next in series:** [Elasticsearch Architecture Essentials](elasticsearch-architecture-essentials.md)

**Previous in series:** [TF-IDF Scoring Explained](tf-idf-scoring-explained.md)

**See also:**
- [TF-IDF Scoring Explained](tf-idf-scoring-explained.md) — the predecessor