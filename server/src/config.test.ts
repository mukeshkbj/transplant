import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({ QLOO_API_KEY: "q", GEMINI_API_KEY: "g" });

    expect(config).toMatchObject({
      QLOO_BASE_URL: "https://hackathon.api.qloo.com",
      GEMINI_MODEL: "gemini-3.5-flash-lite",
      GROQ_MODEL: "openai/gpt-oss-120b",
      PORT: 8787,
      CACHE_PATH: ".cache/qloo.sqlite",
      QUOTA_FLOOR: 1500,
    });
  });

  it("names missing variables without echoing any values", () => {
    expect(() => loadConfig({ GEMINI_API_KEY: "secret-value" })).toThrow(/QLOO_API_KEY/);
    expect(() => loadConfig({ GEMINI_API_KEY: "secret-value" })).not.toThrow(/secret-value/);
  });
});
