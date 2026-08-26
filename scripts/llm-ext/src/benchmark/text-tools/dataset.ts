/**
 * Golden datasets for the four text-tool benchmarks (TRDD-VFXS2ZYY summarize,
 * TRDD-9XOHSYFV topics, TRDD-SYEH38AV sem_deduplicate, TRDD-Q3ERXAAO describe).
 *
 * Every case is HAND-CURATED, real content authored for this corpus (no
 * generated filler): the texts say something concrete, so "did the summary
 * keep the load-bearing facts" and "are these the text's topics" are
 * mechanically checkable. Scoring is deterministic (score.ts) — no LLM judge.
 *
 * Concept matching is synonym-tolerant BY THE DATASET, not by the scorer: a
 * `concepts` entry lists every acceptable surface form, and the scorer only
 * does case-insensitive substring matching against them. Adding tolerance =
 * adding a synonym here, never loosening the scorer.
 */

// ── summarize ──────────────────────────────────────────────────────────────

export interface SummarizeCase {
  id: string;
  text: string;
  maxChars: number;
  /** Each concept = acceptable surface forms; the summary must hit ≥1 form. */
  concepts: string[][];
}

export const SUMMARIZE_CASES: readonly SummarizeCase[] = [
  {
    id: "sum-outage",
    text:
      "On Tuesday morning the payment gateway went down for 47 minutes. The " +
      "root cause was an expired TLS certificate on the internal token-signing " +
      "service: the renewal cron had been disabled during the March data-center " +
      "migration and never re-enabled. Retries from mobile clients tripled the " +
      "load on the auth cluster, which delayed recovery by another ten minutes " +
      "after the certificate was replaced. The incident review proposes " +
      "certificate-expiry monitoring with a 30-day alert window and a checklist " +
      "item making migration freezes reversible by default.",
    maxChars: 300,
    concepts: [
      ["certificate", "TLS"],
      ["payment", "gateway"],
      ["47 minutes", "47-minute", "outage", "down"],
      ["monitoring", "alert", "checklist", "renewal cron", "re-enabled"],
    ],
  },
  {
    id: "sum-lighthouse",
    text:
      "The lighthouse at Punta Carena was completed in 1867 and is one of the " +
      "tallest in Italy. Its original lamp burned rapeseed oil; electrification " +
      "arrived only in 1920, and the keeper's quarters were abandoned in 1976 " +
      "when the light became fully automatic. Today the tower still guides " +
      "shipping around the western cape of Capri, and its red-and-white " +
      "octagonal silhouette appears on most postcards of the island.",
    maxChars: 250,
    concepts: [
      ["lighthouse", "faro", "tower", "light"],
      ["1867"],
      ["Capri", "Punta Carena"],
      ["automatic", "automated", "electrif", "1920", "1976"],
    ],
  },
  {
    id: "sum-enzyme",
    text:
      "Lactase persistence — the ability of adults to digest the milk sugar " +
      "lactose — evolved independently at least four times in human history, " +
      "in northern Europe and in several African pastoralist populations. The " +
      "mutations differ, but each keeps the lactase gene switched on past " +
      "childhood. The trait spread quickly wherever dairying cultures kept " +
      "cattle, one of the clearest known examples of gene-culture coevolution: " +
      "the practice of herding created the selective pressure that reshaped " +
      "the herders' own genomes.",
    maxChars: 280,
    concepts: [
      ["lactase", "lactose", "milk"],
      ["mutation", "gene", "genom"],
      ["independent", "four times", "Europe", "Africa"],
      ["coevolution", "gene-culture", "dairy", "herding", "pastoral"],
    ],
  },
  {
    id: "sum-queue",
    text:
      "Our job queue currently retries failed tasks with a fixed five-second " +
      "delay, which turns every downstream outage into a synchronized stampede " +
      "when the dependency recovers. The proposal replaces it with exponential " +
      "backoff starting at one second, doubling to a five-minute ceiling, plus " +
      "full jitter so retries decorrelate. Dead-lettering after eight attempts " +
      "keeps poison messages from circulating forever, and a per-queue retry " +
      "budget caps the amplification a single incident can produce.",
    maxChars: 260,
    concepts: [
      ["backoff", "exponential"],
      ["jitter"],
      ["retry", "retries"],
      ["dead-letter", "poison", "budget", "cap"],
    ],
  },
  {
    id: "sum-treaty",
    text:
      "The 1959 Antarctic Treaty froze all territorial claims on the continent " +
      "and reserved it for peaceful scientific use. It banned military " +
      "activity and nuclear waste disposal, and established a system of mutual " +
      "inspection: any signatory may examine any other's stations. Originally " +
      "signed by twelve nations, it has grown to over fifty parties, and its " +
      "consensus-based governance has held for more than six decades despite " +
      "rising interest in the continent's mineral resources.",
    maxChars: 270,
    concepts: [
      ["Antarctic", "Antarctica"],
      ["treaty", "1959"],
      ["claims", "territorial", "peaceful", "scientific"],
      ["inspection", "military", "consensus", "governance"],
    ],
  },
  {
    id: "sum-compiler",
    text:
      "Incremental compilation gets its speed from a dependency graph of " +
      "compilation units: when a file changes, only the units whose interface " +
      "actually changed force their dependents to rebuild. The subtlety is " +
      "deciding what counts as the interface — if private function bodies leak " +
      "into it, every edit cascades and the cache is useless; if too little is " +
      "tracked, stale code ships silently. Most production compilers therefore " +
      "hash a deliberately-coarse 'fingerprint' per unit and accept some " +
      "over-rebuilding as the price of soundness.",
    maxChars: 300,
    concepts: [
      ["incremental", "compilation", "compiler"],
      ["dependency", "graph", "dependents"],
      ["interface", "fingerprint", "hash"],
      ["stale", "soundness", "over-rebuild", "cascade"],
    ],
  },
];

// ── topics ─────────────────────────────────────────────────────────────────

export interface TopicsCase {
  id: string;
  text: string;
  /** Acceptable spellings of the language (ISO code and English name). */
  language: string[];
  /**
   * Expected topic concepts; each entry lists acceptable surface forms. A
   * concept is HIT when any keyword OR keyphrase contains any form
   * (case-insensitive substring, both directions for multiword forms).
   */
  concepts: string[][];
}

export const TOPICS_CASES: readonly TopicsCase[] = [
  {
    id: "top-beekeeping",
    text:
      "Urban beekeeping has moved from hobby to municipal policy. Cities from " +
      "Paris to Toronto now license rooftop hives, betting that pollinator " +
      "corridors through parks and balconies can offset agricultural habitat " +
      "loss. Critics warn that dense hive placement can spread varroa mites " +
      "and out-compete wild native bees for forage, arguing that planting " +
      "flowers helps pollinators more than adding another honeybee colony.",
    language: ["en", "english"],
    concepts: [
      ["beekeeping", "hive", "honeybee", "bee"],
      ["urban", "city", "rooftop", "municipal"],
      ["pollinator", "pollination"],
      ["varroa", "native bees", "competition", "habitat"],
    ],
  },
  {
    id: "top-ferrovie",
    text:
      "L'alta velocità ferroviaria ha trasformato i viaggi tra Milano e Roma: " +
      "il treno copre la tratta in meno di tre ore e ha superato l'aereo come " +
      "mezzo preferito dai viaggiatori d'affari. Restano però forti squilibri: " +
      "il Mezzogiorno è servito da poche linee veloci, e il divario " +
      "infrastrutturale tra nord e sud continua ad allargarsi nonostante i " +
      "fondi europei destinati alle nuove tratte.",
    language: ["it", "italian", "italiano"],
    concepts: [
      ["alta velocità", "ferrovia", "treno", "high-speed", "rail"],
      ["Milano", "Roma", "viagg", "travel"],
      ["Mezzogiorno", "sud", "divario", "squilibri", "north-south", "gap"],
      ["infrastruttur", "fondi", "infrastructure", "funding"],
    ],
  },
  {
    id: "top-permafrost",
    text:
      "Thawing permafrost is turning Arctic infrastructure into a moving " +
      "target. Runways, pipelines and apartment blocks built on frozen ground " +
      "are subsiding as the ice beneath them melts, and engineers now design " +
      "foundations with thermosyphons that pump winter cold into the soil. The " +
      "thaw also releases methane, a feedback loop that accelerates the very " +
      "warming that causes it.",
    language: ["en", "english"],
    concepts: [
      ["permafrost", "thaw", "frozen ground"],
      ["Arctic"],
      ["infrastructure", "foundation", "runway", "pipeline", "subsid"],
      ["methane", "feedback", "warming", "climate"],
    ],
  },
  {
    id: "top-sourdough",
    text:
      "Le pain au levain repose sur une fermentation lente menée par des " +
      "levures sauvages et des bactéries lactiques. Cette acidité naturelle " +
      "améliore la conservation du pain, dégrade une partie du gluten et " +
      "libère des arômes complexes qu'une levure industrielle ne produit pas. " +
      "Chaque levain-chef développe avec le temps une flore microbienne " +
      "propre, ce qui explique pourquoi deux boulangeries ne font jamais " +
      "exactement le même pain.",
    language: ["fr", "french", "français"],
    concepts: [
      ["levain", "pain", "sourdough", "bread"],
      ["fermentation", "levures", "bactéries", "yeast", "bacteria"],
      ["acidité", "arômes", "gluten", "flavor", "acidity"],
      ["flore", "microb", "conservation", "microbial"],
    ],
  },
  {
    id: "top-quantum",
    text:
      "Quantum error correction is the field's current bottleneck: physical " +
      "qubits decohere far too fast for useful computation, so thousands of " +
      "them must be woven into a single logical qubit whose errors are " +
      "detected and reversed on the fly. Surface codes dominate today's " +
      "roadmaps because they tolerate relatively noisy hardware, but their " +
      "overhead is brutal — millions of physical qubits for machines that " +
      "could break cryptography.",
    language: ["en", "english"],
    concepts: [
      ["quantum", "qubit"],
      ["error correction", "errors"],
      ["surface code", "logical qubit", "decoher"],
      ["overhead", "cryptography", "hardware", "noise", "noisy"],
    ],
  },
  {
    id: "top-glaciares",
    text:
      "Los glaciares andinos retroceden a un ritmo sin precedentes, y con " +
      "ellos desaparece la reserva de agua que abastece a ciudades como La Paz " +
      "y Lima durante la estación seca. Los agricultores del altiplano ya " +
      "siembran a mayor altitud, mientras los gobiernos discuten embalses y " +
      "plantas desalinizadoras para compensar un caudal que disminuye año " +
      "tras año.",
    language: ["es", "spanish", "español"],
    concepts: [
      ["glaciar", "glacier"],
      ["Andes", "andino", "altiplano", "Andean"],
      ["agua", "reserva", "caudal", "water"],
      ["agricult", "embalse", "desaliniz", "adaptation", "farming", "reservoir"],
    ],
  },
];

// ── sem_deduplicate ────────────────────────────────────────────────────────

export interface SemDedupCase {
  id: string;
  /**
   * Meaning clusters: each inner array holds phrases that mean the SAME thing
   * (any single one of them is an acceptable survivor); a singleton cluster
   * is a phrase with no duplicate, which MUST survive. The input list handed
   * to the tool is the flattened, interleaved union of all clusters.
   */
  clusters: string[][];
}

/** The input list for a case: clusters flattened and interleaved round-robin,
 *  so same-meaning phrases are never adjacent (harder than sorted input). */
export function semDedupInput(c: SemDedupCase): string[] {
  const out: string[] = [];
  const maxLen = Math.max(...c.clusters.map((cl) => cl.length));
  for (let i = 0; i < maxLen; i++) {
    for (const cl of c.clusters) {
      if (i < cl.length) out.push(cl[i]);
    }
  }
  return out;
}

export const SEM_DEDUP_CASES: readonly SemDedupCase[] = [
  {
    // DELIBERATELY avoids the prompt template's own worked examples
    // ("computer programming"/"coding", "rasterize"/"render to image"):
    // a case whose answer is quoted in the instructions measures nothing —
    // the model is simply told which phrases pair up.
    id: "sd-computing",
    clusters: [
      ["unit testing", "writing tests for functions"],
      ["memory leak", "unreleased allocation"],
      ["machine learning"],
      ["data compression", "reducing file size"],
      ["stack trace", "call stack dump", "backtrace"],
    ],
  },
  {
    id: "sd-cooking",
    clusters: [
      ["chop the onions finely", "finely dice the onions", "mince the onions"],
      ["preheat the oven", "warm up the oven beforehand"],
      ["let the dough rest"],
      ["whisk the eggs", "beat the eggs"],
      ["season with salt and pepper"],
    ],
  },
  {
    id: "sd-travel",
    clusters: [
      ["book a flight", "reserve a plane ticket", "purchase airfare"],
      ["rent a car", "hire a vehicle"],
      ["travel insurance"],
      ["pack your luggage", "prepare your suitcase"],
      ["apply for a visa"],
      ["currency exchange", "changing money"],
    ],
  },
  {
    id: "sd-ui",
    clusters: [
      ["dark mode", "night theme", "dark color scheme"],
      ["drag and drop"],
      ["infinite scrolling", "endless scroll"],
      ["keyboard shortcuts", "hotkeys", "key bindings"],
      ["responsive layout", "adapts to screen size"],
      ["tooltip on hover"],
    ],
  },
  {
    id: "sd-fitness",
    clusters: [
      ["lose weight", "shed pounds", "slim down"],
      ["build muscle", "gain muscle mass"],
      ["improve endurance", "increase stamina"],
      ["stretching routine"],
      ["high-intensity interval training", "HIIT workout"],
    ],
  },
  {
    id: "sd-office",
    clusters: [
      ["schedule a meeting", "set up a meeting", "arrange a call"],
      ["quarterly report"],
      ["performance review", "annual evaluation"],
      ["out of office", "away from my desk", "on leave"],
      ["expense reimbursement", "claim back expenses"],
      ["onboarding new hires"],
    ],
  },
];

// ── describe ───────────────────────────────────────────────────────────────

export interface DescribeCase {
  id: string;
  fileName: string;
  content: string;
  maxChars: number;
  /** Concepts the description must hit (synonym-tolerant, like summarize). */
  concepts: string[][];
}

export const DESCRIBE_CASES: readonly DescribeCase[] = [
  {
    id: "desc-prompt-md",
    fileName: "review-prompt.md",
    content:
      "# Code Review Prompt\n\nYou are a strict senior reviewer. For each " +
      "changed file, list defects ordered by severity. Only report issues you " +
      "can prove from the diff: logic errors, unhandled edge cases, race " +
      "conditions, leaked resources. Never comment on style or formatting. " +
      "End with a verdict line: APPROVE or REQUEST_CHANGES.\n",
    maxChars: 400,
    concepts: [
      ["prompt", "instruction"],
      ["code review", "reviewer", "review"],
      ["defect", "issue", "severity", "logic error"],
      ["verdict", "APPROVE", "REQUEST_CHANGES"],
    ],
  },
  {
    id: "desc-csv",
    fileName: "stations.csv",
    content:
      "station_id,name,lat,lon,elevation_m,opened_year\n" +
      "TO01,Torino Porta Nuova,45.0625,7.6781,239,1861\n" +
      "MI02,Milano Centrale,45.4862,9.2049,122,1931\n" +
      "FI03,Firenze Santa Maria Novella,43.7764,11.2481,50,1848\n" +
      "RM04,Roma Termini,41.9009,12.5021,37,1863\n" +
      "NA05,Napoli Centrale,40.8529,14.2724,10,1866\n",
    maxChars: 350,
    concepts: [
      ["csv", "table", "dataset", "list", "tabular", "data"],
      ["station", "railway", "train"],
      ["coordinates", "latitude", "longitude", "location", "geograph"],
      ["Ital"],
    ],
  },
  {
    id: "desc-json-config",
    fileName: "backup-config.json",
    content:
      '{\n  "schedule": "0 3 * * *",\n  "retention_days": 30,\n' +
      '  "targets": ["/var/lib/postgresql", "/etc/nginx"],\n' +
      '  "destination": "s3://acme-backups/prod",\n' +
      '  "encryption": {"enabled": true, "kms_key": "alias/backup"},\n' +
      '  "notify_on_failure": "ops@acme.example"\n}\n',
    maxChars: 350,
    concepts: [
      ["config", "configuration", "JSON"],
      ["backup"],
      ["schedule", "cron", "3", "daily", "nightly"],
      ["S3", "retention", "encrypt", "destination"],
    ],
  },
  {
    id: "desc-css",
    fileName: "print.css",
    content:
      "@media print {\n  nav, footer, .sidebar, .ad-slot { display: none; }\n" +
      "  body { font: 11pt/1.4 Georgia, serif; color: #000; background: #fff; }\n" +
      "  a[href^='http']::after { content: ' (' attr(href) ')'; font-size: 9pt; }\n" +
      "  h1, h2 { page-break-after: avoid; }\n  pre { white-space: pre-wrap; }\n}\n",
    maxChars: 350,
    concepts: [
      ["css", "stylesheet", "style"],
      ["print"],
      ["hide", "hidden", "remove", "display: none", "navigation", "strips"],
      ["serif", "page", "url", "link", "black", "readab"],
    ],
  },
  {
    id: "desc-python",
    fileName: "rate_limiter.py",
    content:
      "import time\nfrom collections import deque\n\n\nclass SlidingWindowLimiter:\n" +
      '    """Allow at most max_calls per window_seconds, per key."""\n\n' +
      "    def __init__(self, max_calls: int, window_seconds: float) -> None:\n" +
      "        self.max_calls = max_calls\n        self.window = window_seconds\n" +
      "        self._hits: dict[str, deque[float]] = {}\n\n" +
      "    def allow(self, key: str) -> bool:\n        now = time.monotonic()\n" +
      "        q = self._hits.setdefault(key, deque())\n" +
      "        while q and now - q[0] > self.window:\n            q.popleft()\n" +
      "        if len(q) >= self.max_calls:\n            return False\n" +
      "        q.append(now)\n        return True\n",
    maxChars: 400,
    concepts: [
      ["Python", "class", "code"],
      ["rate limit", "rate-limit", "limiter", "throttl"],
      ["sliding window", "window"],
      ["per key", "per-key", "max_calls", "calls", "requests"],
    ],
  },
  {
    id: "desc-yaml-ci",
    fileName: "ci.yml",
    content:
      "name: tests\non:\n  pull_request:\n  push:\n    branches: [main]\n" +
      "permissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n" +
      "    timeout-minutes: 15\n    steps:\n      - uses: actions/checkout@v6\n" +
      "      - uses: actions/setup-node@v6\n        with: {node-version: 24, cache: npm}\n" +
      "      - run: npm ci\n      - run: npm test\n",
    maxChars: 350,
    concepts: [
      ["CI", "continuous integration", "workflow", "GitHub Actions", "pipeline"],
      ["test"],
      ["pull request", "push", "main", "trigger"],
      ["Node", "npm"],
    ],
  },
];
