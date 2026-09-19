/**
 * Reproducible, high-variance prompt filler — a native port of the plan's
 * `llm_bench/filler.py`.
 *
 * Why it matters: if every concurrent request sends the same prompt, the shared
 * prefix hits the KV cache and TTFT/prefill numbers become meaningless. This
 * module builds N mutually distinct prompts from a seeded RNG so a concurrency
 * ladder measures real prefill work.
 *
 * Token counts are *estimates*. The plan uses tiktoken `cl100k_base`; a desktop
 * app cannot ship that tokenizer, so we use the same 4-characters-per-token
 * fallback the Python code applies when tiktoken is unavailable. Timing metrics
 * are unaffected — only the input-token label is approximate, and the server's
 * reported `prompt_tokens` always overrides it in results.
 */

/** Diverse English corpus (ported verbatim from `filler.py::_SENTENCE_POOL`). */
export const SENTENCE_POOL: readonly string[] = [
  "The integration of distributed systems requires careful coordination of state across nodes.",
  "Photosynthesis converts solar energy into chemical energy stored in glucose molecules.",
  "Object-oriented programming emphasizes encapsulation inheritance and polymorphism.",
  "The French Revolution fundamentally reshaped European political structures in the late eighteenth century.",
  "Quantum entanglement allows particles to exhibit correlated behavior across vast distances.",
  "Economic inflation erodes purchasing power when money supply outpaces real output growth.",
  "Neural networks learn hierarchical representations through backpropagation and gradient descent.",
  "The mitochondrion is often described as the powerhouse of the eukaryotic cell.",
  "Database normalization reduces redundancy by organizing fields into related tables.",
  "Tectonic plate movement along fault lines is the primary cause of seismic activity.",
  "Cryptography secures communication by transforming plaintext into ciphertext using keys.",
  "The water cycle describes continuous movement of water through evaporation condensation and precipitation.",
  "Concurrency control mechanisms prevent race conditions in multi-threaded environments.",
  "Renaissance art introduced perspective and anatomical realism to European painting.",
  "Natural selection favors traits that improve an organism's reproductive success.",
  "Monetary policy adjusts interest rates to stabilize prices and employment levels.",
  "Graph algorithms like Dijkstra's find shortest paths in weighted networks.",
  "The immune system distinguishes self from non-self through specialized lymphocytes.",
  "Compilers perform lexical syntactic and semantic analysis before code generation.",
  "Ocean currents redistribute thermal energy across the globe influencing regional climates.",
  "Recursion solves problems by expressing them in terms of smaller subproblems.",
  "The Roman Empire's legal innovations influenced modern Western jurisprudence.",
  "DNA replication is semiconservative with each strand serving as a template.",
  "Game theory analyzes strategic interactions among rational decision makers.",
  "Hash tables provide average constant-time lookup using a hash function.",
  "Stellar nucleosynthesis forge heavier elements within the cores of massive stars.",
  "Trade barriers such as tariffs distort comparative advantage and reduce welfare.",
  "Backpropagation computes gradients efficiently via the chain rule of calculus.",
  "The carbon cycle exchanges carbon among atmosphere biosphere oceans and geosphere.",
  "Deadlocks arise when processes cyclically wait for resources held by each other.",
  "The Enlightenment championed reason individualism and skepticism of authority.",
  "Homeostasis maintains stable internal conditions despite external fluctuations.",
  "Dynamic programming breaks problems into overlapping subproblems with optimal substructure.",
  "El Nino disruptions alter Pacific sea surface temperatures and global weather patterns.",
  "Asymmetric encryption uses public private key pairs for secure key exchange.",
  "Meiosis produces haploid gametes with genetic diversity through crossing over.",
  "Supply and demand curves intersect at the market clearing equilibrium price.",
  "Binary search trees maintain ordered keys enabling logarithmic search operations.",
  "Continental drift explains the geographic distribution of fossils across continents.",
  "Reinforcement learning agents maximize cumulative reward through environment interaction.",
];

/** Task prefixes so every prompt differs from the first token onwards. */
export const TASK_PREFIXES: readonly string[] = [
  "Summarize the following text in three sentences.",
  "Translate the key ideas below into a concise outline.",
  "Analyse the argument and list its main assumptions.",
  "Rewrite the following passage in simpler language.",
  "Extract the technical terms and define each one.",
  "Critique the reasoning and suggest improvements.",
  "What questions does this text raise? List five.",
  "Condense this into a single paragraph response.",
  "Identify the cause and effect relationships here.",
  "Generate a brief titled summary of the content.",
  "Explain the core concept to a non-technical reader.",
  "Draft a short response that builds on this context.",
  "What are the implications of the text below? Discuss.",
  "Turn the following into a bullet-point briefing.",
  "Reflect on the methodology and note its limitations.",
];

/** Deterministic 32-bit PRNG (mulberry32); replaces Python's `random.Random(seed)`. */
export function createRandom(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Token estimate matching the Python fallback path (`len(text) // 4`).
 * Kept as a named export so scenarios can label numbers as estimates.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

/**
 * Builds a single-line prompt of roughly `targetTokens` estimated tokens.
 * Mirrors `filler.py::build_prompt`: task prefix, `CONTEXT:` marker, then
 * shuffled corpus sentences until the estimate reaches the target.
 */
export function buildFillerPrompt(seed: number, targetTokens: number): string {
  const random = createRandom(seed);
  const safeTarget = Math.max(8, Math.floor(targetTokens));
  const prefix = TASK_PREFIXES[Math.floor(random() * TASK_PREFIXES.length)] ?? TASK_PREFIXES[0];
  const parts: string[] = [prefix, "CONTEXT:"];
  let length = parts.join(" ").length;
  const targetChars = safeTarget * 4;
  // Bounded so a pathological target cannot spin forever.
  for (let round = 0; length < targetChars && round < 20_000; round += 1) {
    for (const sentence of shuffle([...SENTENCE_POOL], random)) {
      parts.push(sentence);
      length += sentence.length + 1;
      if (length >= targetChars) break;
    }
  }
  return parts.join(" ").replaceAll("\n", " ").replaceAll("\r", " ");
}

/**
 * Builds `count` distinct prompts. The seed step of 7 matches
 * `generate_prompts_file`, so a given (seed, count) pair reproduces the exact
 * same prompt set across runs and across the Python CLI.
 */
export function buildFillerPrompts(count: number, targetTokens: number, seed = 42): string[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) =>
    buildFillerPrompt(seed + index * 7, targetTokens),
  );
}

/* -------------------------------------------------------------------------- */
/* Needle in a haystack (ported from `llm_bench/scenarios/needle.py`)          */
/* -------------------------------------------------------------------------- */

const HAYSTACK_UNIT = [
  "The quick brown fox jumps over the lazy dog. ",
  "In a quiet village, people gather at the market every Sunday morning. ",
  "Trees sway gently in the breeze, and children play near the fountain. ",
  "The local bakery opens at dawn, filling the street with the smell of fresh bread. ",
  "Farmers bring their produce, and merchants set up colorful stalls. ",
  "Old friends exchange stories, and strangers become acquaintances over cups of tea. ",
].join("").repeat(20);

export type Needle = { fact: string; question: string };

/** The plan's three needles and their verification questions. */
export const NEEDLES: readonly Needle[] = [
  {
    fact: "The secret access code for the laboratory is 7-3-9-2-5.",
    question: "What is the secret access code for the laboratory?",
  },
  {
    fact: "Dr. Elena Reyes was born in Lisbon on March 14, 1981.",
    question: "Where and when was Dr. Elena Reyes born?",
  },
  {
    fact: "The treasure was buried under the third oak tree from the river bank.",
    question: "Where was the treasure buried?",
  },
];

/**
 * Builds filler text of roughly `targetTokens` with the needle inserted at
 * `depthPercent` of the document (the plan inserts at the midpoint).
 */
export function buildHaystack(targetTokens: number, needle: string, depthPercent = 50): string {
  const targetChars = Math.max(64, Math.floor(targetTokens) * 4);
  const depth = Math.min(100, Math.max(0, depthPercent)) / 100;
  const beforeChars = Math.floor(targetChars * depth);
  const parts: string[] = [];
  let length = 0;
  while (length < beforeChars) {
    parts.push(HAYSTACK_UNIT);
    length += HAYSTACK_UNIT.length;
  }
  parts.push(`\n\n${needle}\n\n`);
  length += needle.length + 4;
  while (length < targetChars) {
    parts.push(HAYSTACK_UNIT);
    length += HAYSTACK_UNIT.length;
  }
  return parts.join("");
}

/** Keyword verification for each needle (ported from `needle.py::_check_correct`). */
export function checkNeedleAnswer(answer: string, needleIndex: number): boolean {
  const text = answer.toLowerCase();
  if (needleIndex === 0) return text.includes("7-3-9-2-5") || text.includes("73925");
  if (needleIndex === 1) {
    return (text.includes("lisbon") || text.includes("里斯本"))
      && (text.includes("1981") || text.includes("march") || text.includes("3月"));
  }
  if (needleIndex === 2) {
    return (text.includes("third") || text.includes("第三")) && (text.includes("oak") || text.includes("橡"));
  }
  return false;
}
