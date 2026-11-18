// Pure rules for the AI Coach's model label, kept free of server-only imports so they can be tested directly.

/** The model name the person sees, taken from configuration. Never a hard-coded product name. */
export function azureModelLabel(env: Record<string, string | undefined>): string {
  return env.AZURE_OPENAI_MODEL_LABEL?.trim() || "Azure OpenAI";
}
