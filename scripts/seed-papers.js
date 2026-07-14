// One-off seed of a small Generative Retrieval citation graph for testing.
// Usage: node scripts/seed-papers.js [storePath]   (default: ~/uone-knowledge)
const os = require("os");
const path = require("path");
const store = require(path.join(__dirname, "..", "dist", "filestore.js"));

const STORE = process.argv[2] || path.join(os.homedir(), "uone-knowledge");
store.setStorePath(STORE);

const CAT = "Generative Retrieval";
const P = (title, opts) => store.paperUpsert({
  slug: `${CAT}/${title}`, title, category: CAT, topic: "Generative Retrieval",
  ...opts,
});

// Cite by exact title (the resolver matches slug or title).
P("Autoregressive Entity Retrieval (GENRE)", {
  authors: ["Nicola De Cao", "Gautier Izacard", "Sebastian Riedel", "Fabio Petroni"],
  year: 2021, publisher: "ICLR", url: "https://arxiv.org/abs/2010.00904",
  tags: ["autoregressive", "entity-retrieval", "constrained-decoding"],
  conclusions: [
    "Retrieve entities by generating their unique names token-by-token",
    "Constrained beam search over a prefix trie guarantees valid outputs",
    "Avoids storing a dense embedding index for every candidate",
  ],
  cites: [],
  content: "Foundational autoregressive retrieval: generate identifiers instead of scoring a dense index.",
});

P("Transformer Memory as a Differentiable Search Index (DSI)", {
  authors: ["Yi Tay", "Vinh Q. Tran", "Mostafa Dehghani", "Jianmo Ni", "Donald Metzler", "et al."],
  year: 2022, publisher: "NeurIPS", url: "https://arxiv.org/abs/2202.06991",
  tags: ["DSI", "model-based-index", "docid-generation"],
  conclusions: [
    "A single Transformer memorizes the corpus and maps a query directly to a document id",
    "Indexing and retrieval are unified inside one seq2seq model",
    "Semantically structured docids outperform arbitrary/atomic ids",
  ],
  cites: [
    { paper: "Autoregressive Entity Retrieval (GENRE)", note: "extends autoregressive generation from entity names to arbitrary document identifiers" },
  ],
  content: "The differentiable search index (DSI) — the hub paper of model-based generative retrieval.",
});

P("Bridging the Gap Between Indexing and Retrieval for DSI with Query Generation (DSI-QG)", {
  authors: ["Shengyao Zhuang", "Houxing Ren", "Linjun Shou", "Jian Pei", "Ming Gong", "Guido Zuccon", "Daxin Jiang"],
  year: 2022, publisher: "arXiv", url: "https://arxiv.org/abs/2206.10128",
  tags: ["query-generation", "DSI"],
  conclusions: [
    "Represent each document by a set of generated queries to close the indexing/retrieval gap",
    "Cross-encoder query generation substantially improves DSI retrieval",
  ],
  cites: [
    { paper: "Transformer Memory as a Differentiable Search Index (DSI)", note: "augments DSI indexing with generated pseudo-queries so training and inference see the same input distribution" },
  ],
  content: "",
});

P("A Neural Corpus Indexer for Document Retrieval (NCI)", {
  authors: ["Yujing Wang", "Yingyan Hou", "Haonan Wang", "Ziming Miao", "et al."],
  year: 2022, publisher: "NeurIPS", url: "https://arxiv.org/abs/2206.02743",
  tags: ["NCI", "prefix-aware-decoder", "query-generation"],
  conclusions: [
    "End-to-end model generates a document id for a given query",
    "Prefix-aware weight-adaptive decoder plus query generation boosts recall",
    "Outperforms strong dense-retrieval baselines on Natural Questions",
  ],
  cites: [
    { paper: "Transformer Memory as a Differentiable Search Index (DSI)", note: "builds on the differentiable search index formulation with a specialized prefix-aware decoder" },
  ],
  content: "",
});

P("Autoregressive Search Engines: Generating Substrings as Document Identifiers (SEAL)", {
  authors: ["Michele Bevilacqua", "Giuseppe Ottaviano", "Patrick Lewis", "Scott Yih", "Sebastian Riedel", "Fabio Petroni"],
  year: 2022, publisher: "NeurIPS", url: "https://arxiv.org/abs/2204.10628",
  tags: ["SEAL", "ngram-identifiers", "FM-index"],
  conclusions: [
    "Any n-gram occurring in a document can serve as its identifier",
    "An FM-index constrains decoding and maps generated substrings back to documents",
    "No fixed docid vocabulary needs to be learned",
  ],
  cites: [
    { paper: "Transformer Memory as a Differentiable Search Index (DSI)", note: "shares the generative-retrieval paradigm but replaces atomic docids with in-document substrings" },
    { paper: "Autoregressive Entity Retrieval (GENRE)", note: "generalizes constrained autoregressive generation from titles to arbitrary substrings" },
  ],
  content: "",
});

P("Ultron: An Ultimate Retriever on Corpus with a Model-based Indexer", {
  authors: ["Yujia Zhou", "Jing Yao", "Zhicheng Dou", "Ledell Wu", "Ji-Rong Wen"],
  year: 2022, publisher: "arXiv", url: "https://arxiv.org/abs/2208.09257",
  tags: ["Ultron", "docid-design", "three-stage-training"],
  conclusions: [
    "Two docid designs (URL-based and product-quantization) for model-based retrieval",
    "A three-stage training pipeline makes generative retrieval scale better",
  ],
  cites: [
    { paper: "Transformer Memory as a Differentiable Search Index (DSI)", note: "adopts the model-based indexer paradigm and rethinks the docid representation" },
    { paper: "A Neural Corpus Indexer for Document Retrieval (NCI)", note: "improves on NCI's docid design and training recipe" },
  ],
  content: "",
});

P("Recommender Systems with Generative Retrieval (TIGER)", {
  authors: ["Shashank Rajput", "Nikhil Mehta", "Anima Singh", "et al."],
  year: 2023, publisher: "NeurIPS", url: "https://arxiv.org/abs/2305.05065",
  tags: ["recsys", "semantic-ids", "RQ-VAE"],
  conclusions: [
    "Represent items with semantic IDs produced by an RQ-VAE",
    "Autoregressively generate the next item's semantic ID for recommendation",
    "Improves cold-start and generalization over ANN retrieval",
  ],
  cites: [
    { paper: "Transformer Memory as a Differentiable Search Index (DSI)", note: "carries the docid-generation idea from document retrieval into sequential recommendation" },
  ],
  content: "",
});

P("How Does Generative Retrieval Scale to Millions of Passages?", {
  authors: ["Ronak Pradeep", "Kai Hui", "Jai Gupta", "Adam D. Lelkes", "et al."],
  year: 2023, publisher: "arXiv", url: "https://arxiv.org/abs/2305.11841",
  tags: ["scaling", "evaluation"],
  conclusions: [
    "Synthetic query generation is the single most important ingredient for scaling",
    "Naive docid strategies degrade sharply at 8.8M passages",
    "Increasing model size helps but does not by itself solve scaling",
  ],
  cites: [
    { paper: "Transformer Memory as a Differentiable Search Index (DSI)", note: "evaluates the core DSI approach at web scale" },
    { paper: "A Neural Corpus Indexer for Document Retrieval (NCI)", note: "stress-tests NCI's decoder + query-generation recipe at scale" },
    { paper: "Bridging the Gap Between Indexing and Retrieval for DSI with Query Generation (DSI-QG)", note: "confirms generated queries are what makes indexing scale" },
    { paper: "Autoregressive Search Engines: Generating Substrings as Document Identifiers (SEAL)", note: "compares substring identifiers against atomic docids at scale" },
  ],
  content: "",
});

P("Learning to Rank in Generative Retrieval (LTRGR)", {
  authors: ["Yongqi Li", "Nan Yang", "Liang Wang", "Furu Wei", "Wenjie Li"],
  year: 2023, publisher: "arXiv", url: "https://arxiv.org/abs/2306.15222",
  tags: ["learning-to-rank", "passage-retrieval"],
  conclusions: [
    "Add a learning-to-rank training phase on top of generative retrieval",
    "Optimizes the autoregressive model directly for ranking metrics",
  ],
  cites: [
    { paper: "Autoregressive Search Engines: Generating Substrings as Document Identifiers (SEAL)", note: "adds a rank-oriented objective on top of SEAL's substring generation" },
  ],
  content: "",
});

const list = store.paperList();
console.log(`Seeded ${list.length} papers into ${STORE}/papers/${CAT}/`);
for (const p of list) console.log(`  ${p.citationCount}x  ${p.year}  ${p.title}`);
