
const express = require("express");
const OpenAI = require("openai");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "AI Short Drama Factory" });
});

app.post("/api/generate", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "服务器尚未配置 OPENAI_API_KEY"
      });
    }

    const { story, duration, genre } = req.body || {};

    if (!story || typeof story !== "string" || !story.trim()) {
      return res.status(400).json({
        error: "请先输入故事内容"
      });
    }

    const client = new OpenAI({ apiKey });

    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      instructions: `
你是一名专业真人影视短剧编剧和导演。
请根据用户提供的故事制作一集短剧。
要求：
1. 使用中文。
2. 采用真人影视风格。
3. 按指定时长设计节奏。
4. 输出剧名、故事梗概、人物设定。
5. 输出完整对白和场景动作。
6. 输出分镜表，包含镜头、画面、人物动作、对白和时长。
7. 每个镜头提供可用于AI视频生成的画面提示词。
8. 保持人物外貌、服装和场景设定一致。
9. 不要声称已经生成视频。
      `,
      input: `
故事内容：
${story.trim()}

单集时长：${duration || "45"}秒
题材类型：${genre || "都市情感"}

请生成完整制作方案。
      `
    });

    res.json({
      ok: true,
      result: response.output_text || "AI没有返回文本，请重试。"
    });

  } catch (error) {
    console.error("AI生成错误：", error);

    res.status(500).json({
      error: error.message || "AI生成失败，请检查服务器日志。"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Short Drama Factory running on port ${PORT}`);
});
