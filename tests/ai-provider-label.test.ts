import assert from "node:assert/strict";
import test from "node:test";

import { azureModelLabel } from "../src/lib/ai/provider-label.ts";

test("the Coach label comes from the Azure configuration, never a hard-coded product name", () => {
  assert.equal(azureModelLabel({ AZURE_OPENAI_MODEL_LABEL: "GPT-4.1 mini" }), "GPT-4.1 mini");
  assert.equal(azureModelLabel({}), "Azure OpenAI");
  assert.equal(azureModelLabel({ AZURE_OPENAI_MODEL_LABEL: "  " }), "Azure OpenAI");
});
