import "server-only";

import { getAzureChatModel } from "@/lib/ai/azure-openai";
import { azureModelLabel } from "@/lib/ai/provider-label";

/** The AI Coach's chat model: Azure OpenAI only. Analysis data reaches it as derived metrics, never video. */
export function chatModelLabel(): string {
  return azureModelLabel(process.env);
}

export async function getChatModel() {
  return getAzureChatModel();
}
