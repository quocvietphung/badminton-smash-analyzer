import "server-only";

import { createAzure } from "@ai-sdk/azure";

export class AiConfigurationError extends Error {
  constructor(message = "Trợ lý Azure AI chưa được cấu hình.") {
    super(message);
    this.name = "AiConfigurationError";
  }
}

function requiredEnvironmentValue(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new AiConfigurationError(`Thiếu biến môi trường ${name}.`);
  return value;
}

export function getAzureChatModel() {
  if (process.env.AI_ASSISTANT_ENABLED === "false") {
    throw new AiConfigurationError("Trợ lý Azure AI đang tạm tắt.");
  }

  const azure = createAzure({
    resourceName: requiredEnvironmentValue("AZURE_RESOURCE_NAME"),
    apiKey: requiredEnvironmentValue("AZURE_API_KEY"),
    apiVersion: process.env.AZURE_OPENAI_API_VERSION?.trim() || "v1",
  });

  return azure.chat(requiredEnvironmentValue("AZURE_OPENAI_DEPLOYMENT"));
}

export function getChatMaxOutputTokens() {
  const configured = Number(process.env.AI_CHAT_MAX_OUTPUT_TOKENS);
  if (!Number.isFinite(configured)) return 480;
  return Math.min(Math.max(Math.round(configured), 128), 800);
}
