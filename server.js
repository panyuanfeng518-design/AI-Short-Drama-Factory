
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ================================
// 基础配置
// ================================

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

let aiClient = null;

// ================================
// Gemini 初始化
// ================================

async function getAI() {
  if (aiClient) return aiClient;

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("Render 环境变量中没有设置 GEMINI_API_KEY");
  }

  const { GoogleGenAI } = await import("@google/genai");

  aiClient = new GoogleGenAI({
    apiKey
  });

  return aiClient;
}

// ================================
// 文本清理
// ================================

function cleanText(value, maxLength = 5000) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

// ================================
// JSON 解析
// ================================

function parseModelJson(text) {
  if (!text) {
    throw new Error("AI 没有返回内容");
  }

  let content = String(text).trim();

  // 去掉 Markdown JSON 代码围栏
  content = content
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // 直接解析
  try {
    return JSON.parse(content);
  } catch (_) {
    // 尝试提取 JSON 对象
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");

    if (start !== -1 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }
  }

  throw new Error("AI 返回的数据不是有效 JSON，请重新生成");
}

// ================================
// 人物资料标准化
// ================================

function normalizeCharacter(character) {
  return {
    name: cleanText(character.name, 80),
    age: cleanText(character.age, 30),
    gender: cleanText(character.gender, 20),
    height: cleanText(character.height, 30),
    identity: cleanText(character.identity, 300),
    mood: cleanText(character.mood, 300),
    look: cleanText(character.look, 500),
    hair: cleanText(character.hair, 300),
    clothes: cleanText(character.clothes, 500),
    props: cleanText(character.props, 300),
    extra: cleanText(character.extra, 500)
  };
}

// ================================
// Gemini 自动重试
// ================================

function isTemporaryError(error) {
  const message = String(
    error?.message || error || ""
  ).toLowerCase();

  return (
    message.includes("503") ||
    message.includes("unavailable") ||
    message.includes("high demand") ||
    message.includes("429") ||
    message.includes("resource_exhausted") ||
    message.includes("500") ||
    message.includes("internal server error") ||
    message.includes("502") ||
    message.includes("504")
  );
}

async function generateWithRetry(ai, request) {
  const maxAttempts = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(
        `Gemini 请求：第 ${attempt}/${maxAttempts} 次，模型：${MODEL}`
      );

      const response = await ai.models.generateContent({
        model: MODEL,
        ...request
      });

      if (!response || !response.text) {
        throw new Error("Gemini 返回了空内容");
      }

      return response;

    } catch (error) {
      lastError = error;

      console.error(
        `Gemini 第 ${attempt} 次请求失败：`,
        error?.message || error
      );

      if (!isTemporaryError(error) || attempt === maxAttempts) {
        throw error;
      }

      // 逐步延长等待时间：2秒、4秒
      const waitTime = attempt * 2000;

      console.log(
        `服务暂时繁忙，${waitTime / 1000} 秒后自动重试……`
      );

      await new Promise(resolve =>
        setTimeout(resolve, waitTime)
      );
    }
  }

  throw lastError || new Error("Gemini 请求失败");
}

// ================================
// 健康检查
// ================================

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    message: "AI短剧工厂服务运行正常",
    model: MODEL
  });
});

// ================================
// AI 剧本生成
// ================================

app.post("/api/generate", async (req, res) => {
  try {
    const story = cleanText(req.body?.story, 10000);
    const duration = cleanText(req.body?.duration || "45", 10);
    const genre = cleanText(req.body?.genre || "都市短剧", 100);

    if (!story) {
      return res.status(400).json({
        ok: false,
        error: "请先填写故事内容"
      });
    }

    const ai = await getAI();

    // ================================
    // 系统指令
    // ================================

    const systemInstruction = `
你是一名专业的AI真人短剧编剧、导演和人物设定设计师。

请根据用户提供的故事要求，创作适合AI真人视频制作的中文短剧剧本。

必须遵守以下要求：

一、剧本要求
1. 剧情完整，逻辑清晰。
2. 人物性格鲜明。
3. 对白自然，符合人物身份。
4. 场景动作具体，方便AI视频生成。
5. 重要情节要有视觉表现。
6. 根据用户要求控制剧本时长。
7. 如果用户要求连续剧，每集应有明确的冲突、反转和结尾悬念。

二、人物资料要求
请提取剧本中所有有实际剧情作用的人物，包括主角、重要配角和反派。

每个人物尽可能提供：
- name：人物姓名
- age：年龄
- gender：性别
- height：身高
- identity：身份背景
- mood：性格气质
- look：面部与外貌特征
- hair：发型
- clothes：服装
- props：标志性道具
- extra：其他视觉特征

三、人物一致性
1. 同一个人物在不同场景中必须保持身份一致。
2. 不要把同一个人物重复创建为不同角色。
3. 不要随意改变人物年龄、性别、外貌和身份。
4. 没有明确的信息可以填写“未设定”，不要凭空编造关键身份信息。
5. 人物姓名必须使用剧本中的正式称呼。

四、输出格式
只能输出合法 JSON。
不要输出 Markdown。
不要输出代码围栏。
不要在 JSON 前后添加解释。

JSON 格式必须如下：

{
  "script": "完整剧本内容",
  "characters": [
    {
      "name": "人物姓名",
      "age": "年龄",
      "gender": "性别",
      "height": "身高",
      "identity": "身份背景",
      "mood": "性格气质",
      "look": "外貌特征",
      "hair": "发型",
      "clothes": "服装",
      "props": "道具",
      "extra": "其他特征"
    }
  ]
}

characters 必须是数组。
如果没有明确人物，也必须返回空数组。
`;

    // ================================
    // 用户提示词
    // ================================

    const prompt = `
请根据以下要求创作AI真人短剧。

【故事内容】
${story}

【单集时长】
${duration}分钟

【题材类型】
${genre}

请输出完整剧本，并提取全部重要人物资料。

剧本建议包含：
1. 剧名
2. 故事背景
3. 人物关系
4. 场景说明
5. 完整剧情
6. 人物对白
7. 人物动作
8. 镜头说明
9. AI视频生成提示词

请特别注意：
人物资料必须与剧本中的人物保持一致。
`;

    // ================================
    // 调用 Gemini（带自动重试）
    // ================================

    const response = await generateWithRetry(ai, {
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        systemInstruction
      }
    });

    // ================================
    // 解析 AI 返回内容
    // ================================

    const parsed = parseModelJson(response.text);

    const script = cleanText(parsed.script, 90000);

    if (!script) {
      throw new Error("AI 没有生成有效剧本内容");
    }

    const rawCharacters = Array.isArray(parsed.characters)
      ? parsed.characters
      : [];

    const characters = rawCharacters
      .filter(item => item && cleanText(item.name, 80))
      .map(normalizeCharacter);

    // ================================
    // 返回网页
    // ================================

    return res.json({
      ok: true,
      result: script,
      characters,
      characterCount: characters.length,
      model: MODEL
    });

  } catch (error) {
    console.error("剧本生成失败：", error);

    const message = String(
      error?.message || "未知错误"
    );

    const temporary = isTemporaryError(error);

    return res.status(temporary ? 503 : 500).json({
      ok: false,
      error: temporary
        ? "Gemini 服务暂时繁忙，系统已经自动重试，请稍后再试。"
        : message,
      detail: message,
      model: MODEL
    });
  }
});

// ================================
// 启动服务
// ================================

app.listen(PORT, () => {
  console.log(`AI短剧工厂已启动，端口：${PORT}`);
  console.log(`当前 Gemini 模型：${MODEL}`);
});
