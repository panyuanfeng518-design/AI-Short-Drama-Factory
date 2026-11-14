
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "AI Short Drama Factory",
    ai: "Gemini"
  });
});

function cleanText(value, max = 4000) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function normalizeCharacter(raw) {
  if (!raw || typeof raw !== "object") return null;

  const name = cleanText(raw.name, 100);
  if (!name) return null;

  return {
    name,
    age: cleanText(raw.age, 40),
    gender: cleanText(raw.gender, 20) || "未指定",
    height: cleanText(raw.height, 40),
    identity: cleanText(raw.identity, 300),
    mood: cleanText(raw.mood, 500),
    look: cleanText(raw.look, 1500),
    hair: cleanText(raw.hair, 500),
    clothes: cleanText(raw.clothes, 800),
    props: cleanText(raw.props, 500),
    extra: cleanText(raw.extra, 800)
  };
}

function parseModelJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Gemini返回的JSON格式不正确");
    }
    return JSON.parse(match[0]);
  }
}

app.post("/api/generate", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "服务器尚未配置 GEMINI_API_KEY"
      });
    }

    const { story, duration, genre } = req.body || {};

    if (!story || typeof story !== "string" || !story.trim()) {
      return res.status(400).json({
        ok: false,
        error: "请先输入故事内容"
      });
    }

    const model =
      process.env.GEMINI_MODEL || "gemini-3.8-flash";

    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model,
      contents: `
故事内容：
${story.trim()}

单集时长：${duration || "45"}秒
题材类型：${genre || "都市情感"}

请生成完整短剧制作方案。
      `,
      config: {
        responseMimeType: "application/json",
        systemInstruction: `
你是一名专业真人影视短剧编剧和导演。

必须返回合法JSON，不要使用Markdown代码围栏。

JSON结构：
{
  "script": "完整短剧剧本方案",
  "characters": [
    {
      "name": "姓名",
      "age": "年龄",
      "gender": "性别",
      "height": "身高",
      "identity": "人物身份",
      "mood": "性格气质",
      "look": "固定外貌",
      "hair": "固定发型",
      "clothes": "固定服装",
      "props": "武器配饰",
      "extra": "其他固定特征"
    }
  ]
}

剧本要求：
1. 使用中文。
2. 真人影视风格。
3. 输出剧名和故事梗概。
4. 输出人物关系。
5. 输出完整剧情、场景、动作和对白。
6. 输出分镜表，包含镜头、画面、动作、对白和时长。
7. 每个镜头提供AI视频生成提示词。
8. 保持人物外貌、服装和场景一致。
9. 不要声称已经生成视频。

人物要求：
1. 提取所有有剧情作用的主要人物。
2. 每个人物只出现一次。
3. 姓名保持统一。
4. 已知资料尽量填写完整。
5. 未知年龄、身高、五官等信息留空，不得随意编造。
6. 外貌、发型、服装应尽量具体。
7. 人物资料必须适合后续真人演员定妆。
8. script必须包含完整剧本。
        `
      }
    });

    const parsed = parseModelJson(response.text || "{}");

    const characters = Array.isArray(parsed.characters)
      ? parsed.characters
          .map(normalizeCharacter)
          .filter(Boolean)
      : [];

    if (!parsed.script || typeof parsed.script !== "string") {
      throw new Error("Gemini没有返回有效剧本");
    }

    res.json({
      ok: true,
      result: parsed.script,
      characters,
      characterCount: characters.length,
      model
    });

  } catch (error) {
    console.error("Gemini生成错误：", error);

    res.status(500).json({
      ok: false,
      error: error.message || "Gemini生成失败"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `AI Short Drama Factory running on port ${PORT}`
  );
});
