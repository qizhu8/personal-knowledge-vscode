// Seed the "Robust Context Summarization / Containment Verifier" idea + related
// papers as a citation graph, including an Idea node (kind:"idea").
// Usage: node scripts/seed-robust-context.js [storePath]
const os = require("os");
const path = require("path");
const store = require(path.join(__dirname, "..", "dist", "filestore.js"));
store.setStorePath(process.argv[2] || path.join(os.homedir(), "uone-knowledge"));

const CAT = "Robust Context Verification";
const P = (title, o) => store.paperUpsert({ slug: `${CAT}/${title}`, title, category: CAT, ...o });

// ── NLI / faithfulness (the "is Target contained in Reference?" task) ────────
P("A Large Annotated Corpus for Learning Natural Language Inference (SNLI)", {
  authors: ["Samuel R. Bowman", "Gabor Angeli", "Christopher Potts", "Christopher D. Manning"], year: 2015,
  topic: "NLI / Faithfulness", publisher: "EMNLP", url: "https://arxiv.org/abs/1508.05326",
  tags: ["NLI", "entailment", "dataset"],
  conclusions: [
    "Frames containment as entailment: does a premise entail a hypothesis?",
    "Large supervised NLI data enables learning textual entailment/containment",
  ],
  cites: [],
  content: "The entailment formulation underlying 'is the Target contained in the Reference?'.",
});

P("SummaC: Re-Visiting NLI-based Models for Inconsistency Detection in Summarization", {
  authors: ["Philippe Laban", "Tobias Schnabel", "Paul N. Bennett", "Marti A. Hearst"], year: 2022,
  topic: "NLI / Faithfulness", publisher: "TACL", url: "https://arxiv.org/abs/2111.09525",
  tags: ["faithfulness", "NLI", "summarization"],
  conclusions: [
    "Applies sentence-level NLI, aggregated across sentence pairs, to detect unsupported summary content",
    "Segmenting document into sentence units fixes the granularity mismatch that hurt prior NLI checks",
  ],
  cites: [
    { paper: "A Large Annotated Corpus for Learning Natural Language Inference (SNLI)", note: "reuses sentence-level NLI models trained on SNLI-style data for the containment check" },
  ],
  content: "Directly the 'verify Target is entailed by Reference' checker your model is.",
});

P("TRUE: Re-evaluating Factual Consistency Evaluation", {
  authors: ["Or Honovich", "Roee Aharoni", "Jonathan Herzig", "Thomas Scialom", "Idan Szpektor", "et al."], year: 2022,
  topic: "NLI / Faithfulness", publisher: "NAACL", url: "https://arxiv.org/abs/2204.04991",
  tags: ["factual-consistency", "evaluation", "NLI"],
  conclusions: [
    "Standardized benchmark shows large-scale NLI and QG/QA metrics are the strongest containment checkers",
    "Provides example-level meta-evaluation for faithfulness metrics",
  ],
  cites: [
    { paper: "SummaC: Re-Visiting NLI-based Models for Inconsistency Detection in Summarization", note: "benchmarks SummaC-style NLI containment among consistency metrics" },
    { paper: "A Large Annotated Corpus for Learning Natural Language Inference (SNLI)", note: "relies on NLI models rooted in SNLI-style entailment" },
  ],
  content: "",
});

// ── Distractor robustness (robust to irrelevant 'rubbish') ───────────────────
P("Adversarial Examples for Evaluating Reading Comprehension Systems", {
  authors: ["Robin Jia", "Percy Liang"], year: 2017,
  topic: "Distractor Robustness", publisher: "EMNLP", url: "https://arxiv.org/abs/1707.07328",
  tags: ["adversarial", "distractor", "reading-comprehension"],
  conclusions: [
    "Appending a single distractor sentence collapses QA model accuracy",
    "Models latch onto superficial cues rather than truly locating the answer",
  ],
  cites: [],
  content: "Classic demonstration that irrelevant text ('rubbish') breaks comprehension models.",
});

P("Large Language Models Can Be Easily Distracted by Irrelevant Context", {
  authors: ["Freda Shi", "Xinyun Chen", "Kanishka Misra", "Nathan Scales", "David Dohan", "Ed Chi", "Nathanael Schärli", "Denny Zhou"], year: 2023,
  topic: "Distractor Robustness", publisher: "ICML", url: "https://arxiv.org/abs/2302.00093",
  tags: ["distraction", "irrelevant-context", "GSM-IC"],
  conclusions: [
    "Introduces GSM-IC: adding irrelevant sentences dramatically lowers LLM accuracy",
    "Mitigations include self-consistency and instructions to ignore irrelevant info",
  ],
  cites: [
    { paper: "Adversarial Examples for Evaluating Reading Comprehension Systems", note: "extends the distractor-sentence vulnerability from QA to LLM reasoning" },
  ],
  content: "Empirical evidence for exactly the failure your case study found (distraction by irrelevant info).",
});

P("Lost in the Middle: How Language Models Use Long Contexts", {
  authors: ["Nelson F. Liu", "Kevin Lin", "John Hewitt", "Percy Liang", "et al."], year: 2023,
  topic: "Distractor Robustness", publisher: "TACL", url: "https://arxiv.org/abs/2307.03172",
  tags: ["long-context", "position-bias"],
  conclusions: [
    "Relevant content buried among distractors and placed mid-context is often missed",
    "Performance depends strongly on where the true evidence sits in the reference",
  ],
  cites: [],
  content: "Motivates the 'rubbish + text + rubbish' curriculum: position and surrounding noise matter.",
});

P("Making Retrieval-Augmented Language Models Robust to Irrelevant Context", {
  authors: ["Ori Yoran", "Tomer Wolfson", "Ori Ram", "Jonathan Berant"], year: 2023,
  topic: "Distractor Robustness", publisher: "ICLR", url: "https://arxiv.org/abs/2310.01558",
  tags: ["robustness", "NLI-filtering", "data-generation"],
  conclusions: [
    "Fine-tunes the model on automatically generated mixes of relevant and irrelevant contexts",
    "An NLI filter that checks entailment prevents irrelevant passages from hurting performance",
    "~1,000 mixed examples suffice to make the model robust to irrelevant context",
  ],
  cites: [
    { paper: "Large Language Models Can Be Easily Distracted by Irrelevant Context", note: "addresses the distraction problem this paper quantified" },
    { paper: "SummaC: Re-Visiting NLI-based Models for Inconsistency Detection in Summarization", note: "uses NLI entailment filtering, the same containment signal" },
    { paper: "Lost in the Middle: How Language Models Use Long Contexts", note: "targets the buried-relevant-evidence failure mode" },
  ],
  content: "The closest published prior work: train on relevant+irrelevant mixes with NLI filtering.",
});

// ── Diffusion / denoising training (the method inspiration) ──────────────────
P("Extracting and Composing Robust Features with Denoising Autoencoders", {
  authors: ["Pascal Vincent", "Hugo Larochelle", "Yoshua Bengio", "Pierre-Antoine Manzagol"], year: 2008,
  topic: "Diffusion / Denoising", publisher: "ICML", url: "https://doi.org/10.1145/1390156.1390294",
  tags: ["denoising", "robust-features"],
  conclusions: [
    "Training to reconstruct clean input from a corrupted version yields robust representations",
    "Denoising as a training signal is the seed of the 'learn to ignore noise' idea",
  ],
  cites: [],
  content: "The original 'corrupt the input, learn to denoise' training principle.",
});

P("Denoising Diffusion Probabilistic Models (DDPM)", {
  authors: ["Jonathan Ho", "Ajay Jain", "Pieter Abbeel"], year: 2020,
  topic: "Diffusion / Denoising", publisher: "NeurIPS", url: "https://arxiv.org/abs/2006.11239",
  tags: ["diffusion", "denoising", "generative"],
  conclusions: [
    "Learns to reverse a gradual noising process across many noise levels",
    "A curriculum of increasing noise levels is the core diffusion training idea",
  ],
  cites: [],
  content: "The diffusion 'progressively noisier data + learn to denoise' template you want to imitate.",
});

P("Diffusion-LM Improves Controllable Text Generation", {
  authors: ["Xiang Lisa Li", "John Thickstun", "Ishaan Gulrajani", "Percy Liang", "Tatsunori B. Hashimoto"], year: 2022,
  topic: "Diffusion / Denoising", publisher: "NeurIPS", url: "https://arxiv.org/abs/2205.14217",
  tags: ["text-diffusion", "controllable"],
  conclusions: [
    "Adapts continuous diffusion (noising/denoising) to discrete text",
    "Shows the diffusion denoising curriculum is applicable to language",
  ],
  cites: [
    { paper: "Denoising Diffusion Probabilistic Models (DDPM)", note: "ports the DDPM noising/denoising framework to text" },
  ],
  content: "",
});

P("BART: Denoising Sequence-to-Sequence Pre-training", {
  authors: ["Mike Lewis", "Yinhan Liu", "Naman Goyal", "Marjan Ghazvininejad", "et al."], year: 2019,
  topic: "Diffusion / Denoising", publisher: "ACL", url: "https://arxiv.org/abs/1910.13461",
  tags: ["denoising", "pretraining", "seq2seq"],
  conclusions: [
    "Pre-trains by corrupting text (masking, deletion, shuffling) and reconstructing the original",
    "A practical denoising objective for text that tolerates injected noise",
  ],
  cites: [
    { paper: "Extracting and Composing Robust Features with Denoising Autoencoders", note: "scales the denoising-autoencoder objective to seq2seq language pretraining" },
  ],
  content: "",
});

// ── Curriculum + paraphrase robustness (rewording) ───────────────────────────
P("Curriculum Learning", {
  authors: ["Yoshua Bengio", "Jérôme Louradour", "Ronan Collobert", "Jason Weston"], year: 2009,
  topic: "Curriculum", publisher: "ICML", url: "https://doi.org/10.1145/1553374.1553380",
  tags: ["curriculum", "training-schedule"],
  conclusions: [
    "Presenting examples from easy to hard improves training and generalization",
    "Justifies the iteration-by-iteration increase in injected 'rubbish' difficulty",
  ],
  cites: [],
  content: "The theory behind your Iteration 1 → 2 → 3 increasing-noise schedule.",
});

P("Sentence-BERT: Sentence Embeddings using Siamese BERT-Networks", {
  authors: ["Nils Reimers", "Iryna Gurevych"], year: 2019,
  topic: "Paraphrase / Semantic Match", publisher: "EMNLP", url: "https://arxiv.org/abs/1908.10084",
  tags: ["sentence-embeddings", "semantic-similarity"],
  conclusions: [
    "Produces embeddings where paraphrases land close together",
    "Enables matching by meaning rather than surface wording",
  ],
  cites: [],
  content: "",
});

P("SimCSE: Simple Contrastive Learning of Sentence Embeddings", {
  authors: ["Tianyu Gao", "Xingcheng Yao", "Danqi Chen"], year: 2021,
  topic: "Paraphrase / Semantic Match", publisher: "EMNLP", url: "https://arxiv.org/abs/2104.08821",
  tags: ["contrastive", "paraphrase", "robustness"],
  conclusions: [
    "Contrastive training pulls semantically equivalent sentences together, pushes others apart",
    "A recipe for making the model robust to rewording (paraphrase invariance)",
  ],
  cites: [
    { paper: "Sentence-BERT: Sentence Embeddings using Siamese BERT-Networks", note: "improves SBERT-style semantic matching with a contrastive objective" },
  ],
  content: "Supports the 'rewording of text 1 is still Contained' requirement via paraphrase-invariant matching.",
});

// ── The Idea node (kind:"idea") ──────────────────────────────────────────────
store.paperUpsert({
  slug: `${CAT}/Robust Context-Containment Verifier via Denoising Curriculum (IDEA)`,
  title: "Robust Context-Containment Verifier via Denoising Curriculum (IDEA)",
  category: CAT, kind: "idea", topic: "Idea", year: 2026,
  authors: ["Yu Wang"], publisher: "working idea",
  tags: ["idea", "robustness", "denoising-curriculum", "containment"],
  conclusions: [
    "Problem: verify whether Target is Contained in Reference, robustly to (a) irrelevant 'rubbish' and (b) rewording.",
    "Method: a diffusion-style curriculum of increasingly noisy (reference, target, label) triples.",
    "Positives: rubbish+text and rubbish+reworded-text still 'Contained'; rubbish-only is 'Not Contained'.",
    "Goal: teach the verifier to denoise distractors and match meaning, not surface form.",
  ],
  cites: [
    { paper: "Making Retrieval-Augmented Language Models Robust to Irrelevant Context", note: "closest prior work — train on relevant+irrelevant mixes with NLI filtering" },
    { paper: "Large Language Models Can Be Easily Distracted by Irrelevant Context", note: "quantifies the exact distraction failure this idea targets" },
    { paper: "Lost in the Middle: How Language Models Use Long Contexts", note: "motivates the rubbish+text+rubbish (position-varying) curriculum" },
    { paper: "SummaC: Re-Visiting NLI-based Models for Inconsistency Detection in Summarization", note: "the NLI-containment task this verifier performs" },
    { paper: "Denoising Diffusion Probabilistic Models (DDPM)", note: "the increasing-noise / learn-to-denoise training template being imitated" },
    { paper: "BART: Denoising Sequence-to-Sequence Pre-training", note: "practical corrupt-then-reconstruct denoising objective for text" },
    { paper: "Curriculum Learning", note: "the easy-to-hard schedule for the iteration-by-iteration noise increase" },
    { paper: "Adversarial Examples for Evaluating Reading Comprehension Systems", note: "distractor-robustness threat model to train against" },
    { paper: "SimCSE: Simple Contrastive Learning of Sentence Embeddings", note: "paraphrase-invariant matching for the 'rewording still Contained' cases" },
  ],
  content: `# Robust Context-Containment Verifier via Denoising Curriculum

**Robust** means: (1) the model is not distracted by irrelevant information, and
(2) the model actually retrieves the right information. A case study shows the
current accuracy model fails #1 — it is easily distracted.

**Idea:** imitate a diffusion model's denoising by training on a curriculum of
progressively noisier \`(Reference, Target, Label)\` examples:

- **Iter 1** — Reference = text1; Target = text1 → **Contained**
- **Iter 2** — rubbish + text1 (or reworded text1) → **Contained**; rubbish only → **Not Contained**
- **Iter 3** — more rubbish + text1 (or reworded) + more rubbish → **Contained**; more rubbish only → **Not Contained**

The model learns to (a) ignore surrounding rubbish and (b) match reworded content
by meaning, outputting Contained / Not Contained.`,
});

const list = store.paperList();
const ideas = list.filter(p => p.kind === "idea");
console.log(`Seeded ${list.filter(p => p.category === CAT).length} nodes in "${CAT}" (${ideas.length} idea node)`);
for (const p of list.filter(p => p.category === CAT)) {
  console.log(`  ${String(p.citationCount).padStart(2)}x  ${p.kind === "idea" ? "💡" : "  "} ${p.year}  ${p.title}`);
}
