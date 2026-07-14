// Seed a Continual-Learning / dual-memory citation graph (for the "Continual
// Learning Model" idea). Papers + metadata are real; citation edges are a
// reasonable curation ("A cites B" => A is a child of B).
// Usage: node scripts/seed-continual-learning.js [storePath]
const os = require("os");
const path = require("path");
const store = require(path.join(__dirname, "..", "dist", "filestore.js"));
store.setStorePath(process.argv[2] || path.join(os.homedir(), "uone-knowledge"));

const CAT = "Continual Learning";
const P = (title, o) => store.paperUpsert({ slug: `${CAT}/${title}`, title, category: CAT, ...o });

// ── Dual-Memory / Complementary Learning Systems ────────────────────────────
P("Complementary Learning Systems in Hippocampus and Neocortex (CLS)", {
  authors: ["James L. McClelland", "Bruce L. McNaughton", "Randall C. O'Reilly"], year: 1995,
  topic: "Dual-Memory / CLS", publisher: "Psychological Review",
  url: "https://doi.org/10.1037/0033-295X.102.3.419",
  tags: ["neuroscience", "fast-slow", "consolidation"],
  conclusions: [
    "The brain uses two complementary systems: a fast-learning hippocampus and a slow-learning neocortex",
    "Interleaved replay from the fast system consolidates knowledge into the slow system without catastrophic interference",
  ],
  cites: [],
  content: "The neuroscience foundation for a fast quick-learning memory + a slow long-term model with periodic consolidation.",
});

P("Lifelong Learning with Dual-Memory Recurrent Self-Organization", {
  authors: ["German I. Parisi", "Jun Tani", "Cornelius Weber", "Stefan Wermter"], year: 2018,
  topic: "Dual-Memory / CLS", publisher: "Frontiers in Neurorobotics",
  url: "https://arxiv.org/abs/1805.10966",
  tags: ["dual-memory", "self-organization", "replay"],
  conclusions: [
    "Two growing recurrent networks act as episodic (fine-grained) and semantic (compact) memory",
    "The episodic memory periodically replays neural reactivations to consolidate into semantic memory",
  ],
  cites: [
    { paper: "Complementary Learning Systems in Hippocampus and Neocortex (CLS)", note: "operationalizes the fast episodic / slow semantic split from CLS theory" },
  ],
  content: "",
});

P("DualNet: Continual Learning, Fast and Slow", {
  authors: ["Quang Pham", "Chenghao Liu", "Steven C.H. Hoi"], year: 2021,
  topic: "Dual-Memory / CLS", publisher: "NeurIPS",
  url: "https://arxiv.org/abs/2110.00175",
  tags: ["fast-slow", "representation-learning"],
  conclusions: [
    "A slow network learns general representations while a fast network adapts to the current task",
    "Explicitly frames continual learning as a fast-and-slow (CLS-inspired) system",
  ],
  cites: [
    { paper: "Complementary Learning Systems in Hippocampus and Neocortex (CLS)", note: "borrows the fast/slow learner separation directly from CLS" },
    { paper: "Overcoming Catastrophic Forgetting in Neural Networks (EWC)", note: "targets the catastrophic-forgetting problem EWC formalized" },
  ],
  content: "",
});

// ── Retrieval memory (the quick-learning / DB+retrieval side) ────────────────
P("Generalization through Memorization: Nearest Neighbor Language Models (kNN-LM)", {
  authors: ["Urvashi Khandelwal", "Omer Levy", "Dan Jurafsky", "Luke Zettlemoyer", "Mike Lewis"], year: 2020,
  topic: "Retrieval Memory", publisher: "ICLR",
  url: "https://arxiv.org/abs/1911.00172",
  tags: ["non-parametric", "kNN", "datastore"],
  conclusions: [
    "Interpolating an LM with a nearest-neighbor lookup over a datastore of examples improves it without retraining",
    "New knowledge can be added by simply growing the datastore (non-parametric memory)",
  ],
  cites: [],
  content: "The canonical 'store knowledge in an external datastore and retrieve it' mechanism for the quick-learning memory.",
});

P("REALM: Retrieval-Augmented Language Model Pre-Training", {
  authors: ["Kelvin Guu", "Kenton Lee", "Zora Tung", "Panupong Pasupat", "Ming-Wei Chang"], year: 2020,
  topic: "Retrieval Memory", publisher: "ICML",
  url: "https://arxiv.org/abs/2002.08909",
  tags: ["retrieval", "open-domain-QA"],
  conclusions: [
    "Augments an LM with a learned retriever over a knowledge corpus, trained end-to-end",
    "Knowledge is stored in a swappable external index rather than only in the weights",
  ],
  cites: [],
  content: "",
});

P("Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks (RAG)", {
  authors: ["Patrick Lewis", "Ethan Perez", "Aleksandra Piktus", "Fabio Petroni", "et al."], year: 2020,
  topic: "Retrieval Memory", publisher: "NeurIPS",
  url: "https://arxiv.org/abs/2005.11401",
  tags: ["RAG", "retrieval", "generation"],
  conclusions: [
    "Combines a parametric generator with a non-parametric retrieved-passage memory",
    "Knowledge can be updated by editing the retrieval index, no retraining required",
  ],
  cites: [
    { paper: "REALM: Retrieval-Augmented Language Model Pre-Training", note: "builds on REALM's retrieve-then-read pretraining, applying it to generation" },
  ],
  content: "The standard 'database + retrieval' quick-learning pattern for injecting new knowledge fast.",
});

P("Memorizing Transformers", {
  authors: ["Yuhuai Wu", "Markus N. Rabe", "DeLesley Hutchins", "Christian Szegedy"], year: 2022,
  topic: "Retrieval Memory", publisher: "ICLR",
  url: "https://arxiv.org/abs/2203.08913",
  tags: ["kNN-attention", "memory"],
  conclusions: [
    "Adds a non-differentiable external kNN memory that attention can read from at inference",
    "Lets a model memorize new facts by writing to memory instead of updating weights",
  ],
  cites: [
    { paper: "Generalization through Memorization: Nearest Neighbor Language Models (kNN-LM)", note: "extends kNN-LM's datastore idea into the attention mechanism itself" },
  ],
  content: "",
});

P("HippoRAG: Neurobiologically Inspired Long-Term Memory for LLMs", {
  authors: ["Bernal Jiménez Gutiérrez", "Yiheng Shu", "Yu Su", "et al."], year: 2024,
  topic: "Retrieval Memory", publisher: "NeurIPS",
  url: "https://arxiv.org/abs/2405.14831",
  tags: ["knowledge-graph", "hippocampal-indexing"],
  conclusions: [
    "Uses a knowledge-graph 'hippocampal index' + PageRank to integrate new knowledge across passages",
    "Explicitly models the hippocampal-index theory of CLS for retrieval-based long-term memory",
  ],
  cites: [
    { paper: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks (RAG)", note: "improves RAG's flat retrieval with a graph-structured memory index" },
    { paper: "Complementary Learning Systems in Hippocampus and Neocortex (CLS)", note: "implements the hippocampal-indexing role from CLS as a retrieval structure" },
  ],
  content: "",
});

P("Larimar: LLMs with Episodic Memory Control", {
  authors: ["Payel Das", "Subhajit Chaudhury", "Elliot Nelson", "et al."], year: 2024,
  topic: "Retrieval Memory", publisher: "ICML",
  url: "https://arxiv.org/abs/2403.11901",
  tags: ["episodic-memory", "editing", "one-shot"],
  conclusions: [
    "Attaches an external episodic memory that can be written/updated in one shot for fast knowledge editing",
    "Bridges retrieval memory and weight editing — update memory now, optionally consolidate later",
  ],
  cites: [
    { paper: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks (RAG)", note: "uses an external memory like RAG but makes it writable for editing" },
    { paper: "Mass-Editing Memory in a Transformer (MEMIT)", note: "offers a fast episodic-memory alternative to MEMIT-style weight edits" },
    { paper: "Complementary Learning Systems in Hippocampus and Neocortex (CLS)", note: "casts the writable memory as a CLS-style episodic store" },
  ],
  content: "",
});

// ── Routing / Modularity ─────────────────────────────────────────────────────
P("Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer (MoE)", {
  authors: ["Noam Shazeer", "Azalia Mirhoseini", "Krzysztof Maziarz", "et al."], year: 2017,
  topic: "Routing / Modularity", publisher: "ICLR",
  url: "https://arxiv.org/abs/1701.06538",
  tags: ["MoE", "routing", "conditional-computation"],
  conclusions: [
    "A trainable gating network routes each input to a sparse subset of expert sub-networks",
    "Establishes the router + experts pattern reused for modular knowledge and editing",
  ],
  cites: [],
  content: "The routing mechanism your design needs to decide long-term vs quick-learning vs new-knowledge.",
});

P("Modular Deep Learning", {
  authors: ["Jonas Pfeiffer", "Sebastian Ruder", "Ivan Vulić", "Edoardo Maria Ponti"], year: 2023,
  topic: "Routing / Modularity", publisher: "TMLR (survey)",
  url: "https://arxiv.org/abs/2302.11529",
  tags: ["modularity", "adapters", "routing", "survey"],
  conclusions: [
    "Unifies parameter-efficient modules + conditional routing + aggregation into one framework",
    "Separating computation from routing enables positive transfer and avoids interference",
  ],
  cites: [
    { paper: "Overcoming Catastrophic Forgetting in Neural Networks (EWC)", note: "positions modularity as an alternative to regularization methods like EWC" },
    { paper: "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer (MoE)", note: "generalizes MoE routing into a broad modular-routing taxonomy" },
  ],
  content: "",
});

// ── Model editing (the long-term / baked-into-weights side) ──────────────────
P("Mass-Editing Memory in a Transformer (MEMIT)", {
  authors: ["Kevin Meng", "Arnab Sen Sharma", "Alex Andonian", "Yonatan Belinkov", "David Bau"], year: 2022,
  topic: "Model Editing", publisher: "ICLR",
  url: "https://arxiv.org/abs/2210.07229",
  tags: ["knowledge-editing", "locate-then-edit"],
  conclusions: [
    "Directly edits thousands of facts into specific MLP weights of a transformer",
    "Shows knowledge can be 'baked' into weights precisely — the long-term consolidation step",
  ],
  cites: [],
  content: "The mechanism for consolidating knowledge into the long-term model's weights.",
});

P("Aging with GRACE: Lifelong Model Editing with Discrete Key-Value Adaptors", {
  authors: ["Thomas Hartvigsen", "Swami Sankaranarayanan", "Hamid Palangi", "Yoon Kim", "Marzyeh Ghassemi"], year: 2022,
  topic: "Model Editing", publisher: "NeurIPS",
  url: "https://arxiv.org/abs/2211.11031",
  tags: ["key-value", "adaptor", "lifelong-editing"],
  conclusions: [
    "Stores edits in a discrete key-value codebook adaptor rather than overwriting weights",
    "Enables thousands of sequential edits without degrading earlier ones",
  ],
  cites: [
    { paper: "Mass-Editing Memory in a Transformer (MEMIT)", note: "avoids MEMIT's destructive weight edits by using an external key-value adaptor" },
  ],
  content: "",
});

P("WISE: Rethinking the Knowledge Memory for Lifelong Model Editing", {
  authors: ["Peng Wang", "Zexi Li", "Ningyu Zhang", "et al."], year: 2024,
  topic: "Model Editing", publisher: "NeurIPS",
  url: "https://arxiv.org/abs/2405.14768",
  tags: ["dual-memory", "side-memory", "routing"],
  conclusions: [
    "Splits memory into a main (long-term) memory and a side (edit) memory with a router",
    "Directly a dual-memory design: stable pretrained knowledge + a fast-editable side memory",
  ],
  cites: [
    { paper: "Mass-Editing Memory in a Transformer (MEMIT)", note: "contrasts its side-memory with MEMIT's in-place weight editing" },
    { paper: "Aging with GRACE: Lifelong Model Editing with Discrete Key-Value Adaptors", note: "extends GRACE's external-memory editing to a routed dual memory" },
    { paper: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks (RAG)", note: "compares editable memory against retrieval-based knowledge injection" },
  ],
  content: "Closest published analogue to the proposed long-term + quick-learning + router design.",
});

P("LEMoE: Advanced Mixture of Experts Adaptor for Lifelong Model Editing", {
  authors: ["Renzhi Wang", "Piji Li"], year: 2024,
  topic: "Model Editing", publisher: "EMNLP",
  url: "https://aclanthology.org/2024.emnlp-main.149/",
  tags: ["MoE-adaptor", "routing", "lifelong-editing"],
  conclusions: [
    "A MoE adaptor for lifelong editing with KV-anchor routing for train/inference consistency",
    "Analyzes forgetting, inconsistent routing, and order sensitivity in MoE editing",
  ],
  cites: [
    { paper: "Mass-Editing Memory in a Transformer (MEMIT)", note: "improves over locate-then-edit methods like MEMIT for the lifelong setting" },
    { paper: "Aging with GRACE: Lifelong Model Editing with Discrete Key-Value Adaptors", note: "builds on GRACE-style external adaptors, adding a MoE router" },
    { paper: "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer (MoE)", note: "adopts sparsely-gated MoE routing for edit experts" },
    { paper: "Modular Deep Learning", note: "instantiates the modular routing framework for model editing" },
  ],
  content: "",
});

// ── Continual learning (regularization + surveys) ────────────────────────────
P("Overcoming Catastrophic Forgetting in Neural Networks (EWC)", {
  authors: ["James Kirkpatrick", "Razvan Pascanu", "Neil Rabinowitz", "et al."], year: 2017,
  topic: "Continual Learning", publisher: "PNAS",
  url: "https://arxiv.org/abs/1612.00796",
  tags: ["EWC", "regularization", "catastrophic-forgetting"],
  conclusions: [
    "Slows learning on weights important to prior tasks via a Fisher-information penalty",
    "Foundational statement of the catastrophic-forgetting problem all CL methods address",
  ],
  cites: [],
  content: "Why a single trained model can't just keep learning new knowledge — motivates the split architecture.",
});

P("Continual Learning of Large Language Models: A Comprehensive Survey", {
  authors: ["Haizhou Shi", "Zihao Xu", "Hengyi Wang", "Zifeng Wang", "Sayna Ebrahimi", "Hao Wang", "et al."], year: 2024,
  topic: "Continual Learning", publisher: "ACM Computing Surveys",
  url: "https://arxiv.org/abs/2404.16789",
  tags: ["survey", "LLM", "continual-learning"],
  conclusions: [
    "Organizes CL for LLMs into continual pre-training, domain-adaptive pre-training, and fine-tuning",
    "Covers regularization, replay, modular, and editing-based approaches to updating LLMs",
  ],
  cites: [
    { paper: "Overcoming Catastrophic Forgetting in Neural Networks (EWC)", note: "surveys EWC as a core regularization-based CL method" },
    { paper: "DualNet: Continual Learning, Fast and Slow", note: "cites DualNet as a fast-slow architecture approach" },
    { paper: "Modular Deep Learning", note: "cites modular/PEFT methods for continual adaptation" },
    { paper: "LEMoE: Advanced Mixture of Experts Adaptor for Lifelong Model Editing", note: "covers LEMoE under continual model refinement / editing" },
    { paper: "WISE: Rethinking the Knowledge Memory for Lifelong Model Editing", note: "covers WISE's dual knowledge memory under lifelong editing" },
    { paper: "Generalization through Memorization: Nearest Neighbor Language Models (kNN-LM)", note: "references non-parametric memory as a knowledge-update route" },
    { paper: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks (RAG)", note: "covers retrieval augmentation as a way to add knowledge without training" },
    { paper: "Mass-Editing Memory in a Transformer (MEMIT)", note: "covers MEMIT under knowledge-editing methods" },
  ],
  content: "Your primary map of the design space; the reference you supplied.",
});

P("A Comprehensive Survey of Continual Learning: Theory, Method and Application", {
  authors: ["Liyuan Wang", "Xingxing Zhang", "Hang Su", "Jun Zhu"], year: 2024,
  topic: "Continual Learning", publisher: "IEEE TPAMI",
  url: "https://arxiv.org/abs/2302.00487",
  tags: ["survey", "continual-learning", "taxonomy"],
  conclusions: [
    "Taxonomizes continual learning into regularization, replay, architecture, and representation methods",
    "Connects biological memory consolidation to machine continual learning",
  ],
  cites: [
    { paper: "Overcoming Catastrophic Forgetting in Neural Networks (EWC)", note: "classifies EWC under regularization-based methods" },
    { paper: "DualNet: Continual Learning, Fast and Slow", note: "discusses DualNet under architecture/representation methods" },
    { paper: "Complementary Learning Systems in Hippocampus and Neocortex (CLS)", note: "draws on CLS for the biological basis of consolidation" },
    { paper: "Lifelong Learning with Dual-Memory Recurrent Self-Organization", note: "cites dual-memory self-organization as a bio-inspired architecture" },
  ],
  content: "",
});

const list = store.paperList();
console.log(`Seeded ${list.length} papers into "${CAT}"`);
for (const p of list) console.log(`  ${String(p.citationCount).padStart(2)}x  ${p.year}  ${p.title}`);
