export const MODEL_PRESETS = [
  {
    id: "Qwen/Qwen2.5-1.5B-Instruct",
    label: "Qwen2.5 1.5B",
    note: "Fast starter · ~4 GB",
    maxModelLen: 8192,
    gpuMemory: 0.85,
  },
  {
    id: "meta-llama/Llama-3.2-1B-Instruct",
    label: "Llama 3.2 1B",
    note: "Tiny & quick · ~3 GB",
    maxModelLen: 8192,
    gpuMemory: 0.85,
  },
  {
    id: "Qwen/Qwen2.5-7B-Instruct",
    label: "Qwen2.5 7B",
    note: "Balanced · ~16 GB",
    maxModelLen: 8192,
    gpuMemory: 0.9,
  },
  {
    id: "Qwen/Qwen2.5-7B-Instruct-AWQ",
    label: "Qwen2.5 7B AWQ",
    note: "4-bit · ~6 GB",
    maxModelLen: 8192,
    gpuMemory: 0.9,
    quantization: "awq" as const,
  },
  {
    id: "mistralai/Mistral-7B-Instruct-v0.3",
    label: "Mistral 7B",
    note: "General · ~16 GB",
    maxModelLen: 8192,
    gpuMemory: 0.9,
  },
  {
    id: "meta-llama/Llama-3.1-8B-Instruct",
    label: "Llama 3.1 8B",
    note: "Strong 8B · ~18 GB",
    maxModelLen: 8192,
    gpuMemory: 0.92,
  },
];

export const QUANTIZATION_OPTIONS = [
  { value: "none", label: "None (model default)" },
  { value: "awq", label: "AWQ (4-bit)" },
  { value: "gptq", label: "GPTQ (4-bit)" },
  { value: "fp8", label: "FP8" },
  { value: "bitsandbytes", label: "bitsandbytes" },
  { value: "gguf", label: "GGUF" },
  { value: "marlin", label: "Marlin" },
  { value: "aqlm", label: "AQLM" },
  { value: "smoothquant", label: "SmoothQuant" },
];

export const DTYPE_OPTIONS = [
  { value: "auto", label: "Auto (recommended)" },
  { value: "float16", label: "float16" },
  { value: "bfloat16", label: "bfloat16" },
  { value: "float32", label: "float32" },
];

export const SWEEP_PARAMETERS = [
  { value: "temperature", label: "Temperature", min: 0, max: 2, step: 0.1, default: "0.1, 0.4, 0.7, 1.0, 1.3" },
  { value: "top_p", label: "Top-p", min: 0.05, max: 1, step: 0.05, default: "0.5, 0.7, 0.9, 1.0" },
  { value: "top_k", label: "Top-k", min: 1, max: 1000, step: 1, default: "1, 10, 40, 100" },
  { value: "max_tokens", label: "Max tokens", min: 1, max: 4096, step: 32, default: "64, 128, 256" },
  { value: "repetition_penalty", label: "Repetition penalty", min: 0.5, max: 2, step: 0.05, default: "1.0, 1.1, 1.2" },
  { value: "presence_penalty", label: "Presence penalty", min: -2, max: 2, step: 0.1, default: "-1.0, 0, 1.0" },
  { value: "frequency_penalty", label: "Frequency penalty", min: -2, max: 2, step: 0.1, default: "-1.0, 0, 1.0" },
] as const;

export const SOURCE_LABELS: Record<string, string> = {
  playground: "Playground",
  compare: "Compare",
  sweep: "Sweep",
  api: "OpenAI API",
};
