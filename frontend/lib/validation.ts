import { z } from "zod";

import type { ServerConfig } from "./types";

export const serverConfigSchema = z.object({
  model: z
    .string()
    .trim()
    .min(1, "A model id or local path is required.")
    .max(512, "Model id is too long.")
    .refine((value) => !value.includes("://"), "Use a Hugging Face id or local path, not a URL."),
  served_model_name: z.string().max(128).nullable(),
  max_model_len: z
    .number()
    .int("Must be a whole number.")
    .min(256, "At least 256 tokens.")
    .max(1_048_576, "At most 1,048,576 tokens."),
  gpu_memory_utilization: z
    .number()
    .min(0.05, "Must be at least 0.05.")
    .max(0.99, "Must be at most 0.99 (leave headroom for the OS)."),
  tensor_parallel_size: z
    .number()
    .int("Must be a whole number.")
    .min(1, "At least 1 GPU.")
    .max(16, "At most 16 GPUs."),
  dtype: z.enum(["auto", "float16", "bfloat16", "float32"]),
  quantization: z
    .enum(["awq", "gptq", "fp8", "bitsandbytes", "gguf", "aqlm", "marlin", "smoothquant"])
    .nullable(),
  trust_remote_code: z.boolean(),
  enforce_eager: z.boolean(),
  max_num_seqs: z.number().int().min(1).max(4096).nullable(),
  extra_args: z.array(z.string().max(512)).max(40),
});

export type ConfigErrors = Record<string, string>;

export function validateServerConfig(config: ServerConfig): {
  ok: boolean;
  errors: ConfigErrors;
} {
  const parsed = serverConfigSchema.safeParse(config);
  if (parsed.success) return { ok: true, errors: {} };

  const errors: ConfigErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0]?.toString() ?? "form";
    if (!errors[field]) errors[field] = issue.message;
  }
  return { ok: false, errors };
}
