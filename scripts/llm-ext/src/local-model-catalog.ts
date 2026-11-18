// The local model catalog: one entry per local model llm-ext knows, with its role, runtime, accepted inputs and limits.
// Listing a model here never downloads it and never calibrates it.
// Today only local-model-catalog.test.ts reads this file; TRDD-C7ACDK79, TRDD-GLK56Q6F and TRDD-RS2MTVP7 will consume it.
// Sizes come from the Hugging Face API (GET /api/models/<repo>?blobs=true), read on 2026-11-18.

export type LocalRuntime = "llama.cpp" | "mlx-locals" | "mlx-decision" | "vendor";
export type LocalRole = "chat" | "decider" | "speech";
export type LocalInput = "text" | "image" | "audio" | "video";

export interface LocalModelEntry {
  /** Exactly as a profile field or the decider names it. */
  id: string;
  /** Absent when the weights are not known (the served decider). */
  repo?: string;
  runtime: LocalRuntime;
  role: LocalRole;
  /** What the model accepts per its card, not what llm-ext sends (llm-ext sends text only today). */
  inputs: readonly LocalInput[];
  /** The projector file the entry would use. */
  mmproj?: string;
  /** Refusals removed, per the model card. */
  abliterated: boolean;
  /** From the Hugging Face API, in bytes. */
  sizeBytes?: { weights: number; mmproj?: number };
  /** How a maintainer saw it run; null when not recorded. */
  verified: { how: string } | null;
  /** Why llm-ext cannot run it. */
  unsupportedReason?: string;
}

export const LOCAL_MODEL_CATALOG: readonly LocalModelEntry[] = [
  {
    id: "AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K",
    repo: "AtomicChat/LFM3-1.7B-Uncensored-GGUF",
    runtime: "llama.cpp",
    role: "chat",
    inputs: ["text"],
    abliterated: true,
    sizeBytes: { weights: 1587969920 },
    verified: { how: "llama-cli -hf on llama.cpp b11960-8642541b2 loaded it and answered at about 107 tokens/s, 2026-10-28 (TRDD-1OOAH3LD); llm-ext models calibrate Phase A PASS, 2026-10-29 (TRDD-R7NKAJ5B)" },
  },
  {
    id: "bartowski/Nanbeige_Nanbeige4.2-3B-GGUF/Nanbeige_Nanbeige4.2-3B-Q6_K.gguf",
    repo: "bartowski/Nanbeige_Nanbeige4.2-3B-GGUF",
    runtime: "llama.cpp",
    role: "chat",
    inputs: ["text"],
    abliterated: false,
    sizeBytes: { weights: 3595603104 },
    verified: { how: "llama-server loaded it and answered in the six-model smoke outside llm-ext, 2026-10-28; llm-ext models calibrate Phase A PASS, 2026-10-29 (TRDD-R7NKAJ5B)" },
  },
  {
    id: "insraq/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF-Q8_0.gguf",
    repo: "insraq/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF",
    runtime: "llama.cpp",
    role: "chat",
    inputs: ["text"],
    abliterated: true,
    sizeBytes: { weights: 4610580640 },
    verified: { how: "llama-server loaded it and answered in the six-model smoke outside llm-ext, 2026-10-28; llm-ext models calibrate Phase A PASS, 2026-10-29 (TRDD-R7NKAJ5B)" },
  },
  {
    id: "LiquidAI/LFM3-1.7B-MLX-4bit",
    repo: "LiquidAI/LFM3-1.7B-MLX-4bit",
    runtime: "mlx-locals",
    role: "chat",
    inputs: ["text"],
    abliterated: false,
    sizeBytes: { weights: 973083386 },
    verified: { how: "the Locals server loaded it and answered in the six-model smoke outside llm-ext, 2026-10-28; llm-ext models calibrate Phase A PASS, 2026-10-29; a full calibration finished 2026-11-15 with fill tokens 0 for every kind (TRDD-R7NKAJ5B)" },
  },
  {
    id: "mlx-community/Nanbeige4.2-3B-OptiQ-4bit",
    repo: "mlx-community/Nanbeige4.2-3B-OptiQ-4bit",
    runtime: "mlx-locals",
    role: "chat",
    inputs: ["text"],
    abliterated: false,
    sizeBytes: { weights: 3303644285 },
    verified: { how: "the Locals server loaded it and answered in the six-model smoke outside llm-ext, 2026-10-28; llm-ext models calibrate Phase A PASS, 2026-10-29 (TRDD-R7NKAJ5B)" },
  },
  {
    id: "mlx-community/Qwen3.5-4B-MLX-4bit",
    repo: "mlx-community/Qwen3.5-4B-MLX-4bit",
    runtime: "mlx-locals",
    role: "chat",
    inputs: ["text"],
    abliterated: false,
    sizeBytes: { weights: 3034300695 },
    verified: { how: "the Locals server loaded it and answered in the six-model smoke outside llm-ext, 2026-10-28; llm-ext models calibrate Phase A PASS, 2026-10-29 (TRDD-R7NKAJ5B)" },
  },
  {
    id: "AtomicChat/LFM3-VL-2B-GGUF:AD-Q4_K_M",
    repo: "AtomicChat/LFM3-VL-2B-GGUF",
    runtime: "llama.cpp",
    role: "chat",
    inputs: ["text", "image"],
    mmproj: "mmproj-LFM3-VL-2B-F16.gguf",
    abliterated: false,
    sizeBytes: { weights: 1132207168, mmproj: 378995488 },
    verified: null,
  },
  {
    id: "AtomicChat/LFM3-Omni-2B-GGUF:AD-Q4_K_M",
    repo: "AtomicChat/LFM3-Omni-2B-GGUF",
    runtime: "llama.cpp",
    role: "chat",
    inputs: ["text", "image", "audio"],
    mmproj: "mmproj-LFM3-Omni-2B-F16.gguf",
    abliterated: false,
    sizeBytes: { weights: 1132209888, mmproj: 949841152 },
    verified: null,
  },
  {
    id: "AtomicChat/LFM3-Audio-2B-GGUF:AD-Q4_K_M",
    repo: "AtomicChat/LFM3-Audio-2B-GGUF",
    runtime: "llama.cpp",
    role: "speech",
    inputs: ["text", "audio"],
    mmproj: "mmproj-LFM3-Audio-2B-F16.gguf",
    abliterated: false,
    sizeBytes: { weights: 1132205824, mmproj: 570846304 },
    verified: null,
    unsupportedReason: "a speech model (ASR and TTS); llm-ext sends text completions only.",
  },
  {
    id: "abliter8-ai/lfm3-2b-vl-abliter8-gguf:Q4_K_M",
    repo: "abliter8-ai/lfm3-2b-vl-abliter8-gguf",
    runtime: "llama.cpp",
    role: "chat",
    inputs: ["text", "image"],
    mmproj: "mmproj-LFM3-VL-2B-Abliter8-BF16.gguf",
    abliterated: true,
    sizeBytes: { weights: 1099627392, mmproj: 378995328 },
    verified: null,
  },
  {
    id: "mizahnyx/lfm3-omni-2b-abliterated-heretic-v2-GGUF:Q4_K_M",
    repo: "mizahnyx/lfm3-omni-2b-abliterated-heretic-v2-GGUF",
    runtime: "llama.cpp",
    role: "chat",
    inputs: ["text", "image", "audio", "video"],
    mmproj: "mmproj-LFM3-Omni-2B-Q8_0.gguf",
    abliterated: true,
    sizeBytes: { weights: 1099629696, mmproj: 506841856 },
    verified: null,
  },
  {
    id: "baselabs/elephant-1",
    repo: "baselabs/elephant-1",
    runtime: "vendor",
    role: "decider",
    inputs: ["text", "image"],
    abliterated: false,
    sizeBytes: { weights: 18819722392 },
    verified: null,
    unsupportedReason: "CUDA-only safetensors run by the vendor engine (qev); llm-ext reaches the decider only through the mlx-decision server.",
  },
  {
    id: "sergolsub/mlx-elephant-v1-9B",
    repo: "sergolsub/mlx-elephant-v1-9B",
    runtime: "vendor",
    role: "decider",
    inputs: ["text", "image"],
    abliterated: false,
    sizeBytes: { weights: 11380138801 },
    verified: null,
    unsupportedReason: "MLX weights run by the vendor loader onejev_mlx.py, not by mlx_lm or Locals; llm-ext reaches the decider only through the mlx-decision server.",
  },
  {
    // WHY: a literal, not SERVED_MODEL: local-decider.ts will read this catalog (TRDD-GLK56Q6F), so importing it here would be a cycle; the test keeps it equal to SERVED_MODEL.
    id: "elephant-1",
    runtime: "mlx-decision",
    role: "decider",
    inputs: ["text"],
    abliterated: false,
    verified: { how: "the mlx-decision server reported loaded elephant-1 on GET /health, 2026-11-18" },
  },
];
