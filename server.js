
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
let aiClient = null;

async function getAI() {
  if (aiClient) return aiClient;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Render 环境变量中没有设置 GEMINI_API_KEY");

  const { GoogleGenAI } = await import("@google/genai");
  aiClient = new GoogleGenAI({ apiKey });
  return aiClient;
}

function cleanText(value, maxLength = 5000) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function parseModelJson(text) {
  if (!text) throw new Error("AI 没有返回内容");

  let content = String(text).trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(content);
  } catch (_) {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }
  }

  throw new Error("AI 返回的数据不是有效 JSON，请重新生成");
}

function normalizeCharacter(c) {
  return {
    name: cleanText(c.name, 80),
    age: cleanText(c.age, 30),
    gender: cleanText(c.gender, 20),
    height: cleanText(c.height, 30),
    identity: cleanText(c.identity, 300),
    mood: cleanText(c.mood, 300),
    look: cleanText(c.look, 500),
    hair: cleanText(c.hair, 300),
    clothes: cleanText(c.clothes, 500),
    props: cleanText(c.props, 300),
    extra: cleanText(c.extra, 500)
  };
}

function isTemporaryError(error) {
  const message = String(error?.message || error || "").toLowerCase();

  return [
    "503", "unavailable", "high demand",
    "429", "resource_exhausted",
    "500", "internal server error", "502", "504"
  ].some(x => message.includes(x));
}

async function generateWithRetry(ai, request) {
  const maxAttempts = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`Gemini 请求：第 ${attempt}/${maxAttempts} 次，模型：${MODEL}`);

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
      console.error(`Gemini 第 ${attempt} 次请求失败：`, error?.message || error);

      if (!isTemporaryError(error) || attempt === maxAttempts) {
        throw error;
      }

      const waitTime = attempt * 2000;
      console.log(`${waitTime / 1000} 秒后自动重试……`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  throw lastError || new Error("Gemini 请求失败");
}

function errorResponse(res, error) {
  console.error("AI请求失败：", error);
  const message = String(error?.message || "未知错误");
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

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    message: "AI短剧工厂服务运行正常",
    model: MODEL
  });
});

// =====================================
// 剧本生成：时长统一使用秒
// =====================================

app.post("/api/generate", async (req, res) => {
  try {
    const story = cleanText(req.body?.story, 10000);
    const duration = Number(req.body?.duration || 60);
    const genre = cleanText(req.body?.genre || "都市短剧", 100);

    if (!story) {
      return res.status(400).json({ ok: false, error: "请先填写故事内容" });
    }

    if (![60, 90, 120].includes(duration)) {
      return res.status(400).json({
        ok: false,
        error: "单集时长只能选择60、90或120秒"
      });
    }

    const ai = await getAI();

    const systemInstruction = `
你是一名专业的AI真人短剧编剧、导演和人物设定设计师。

请创作适合真人AI视频制作的中文短剧。

要求：
1. 剧情完整，逻辑清晰，节奏紧凑。
2. 人物性格鲜明，对白自然。
3. 动作、表情、场景和视觉表现具体。
4. 必须严格控制在用户指定的秒数范围内。
5. 重要情节要有视觉表现。
6. 如果是连续剧，本集必须有冲突、反转和结尾悬念。
7. 提取所有有实际剧情作用的人物。
8. 同一个人物不能重复创建。
9. 人物外貌、年龄、性别和身份必须保持一致。
10. 没有明确的信息填写“未设定”，不要编造关键身份。

只能输出合法JSON，不要输出Markdown或解释。

格式：
{
  "script": "完整剧本，包含剧名、背景、人物关系、场景、动作、对白、剧情和结尾悬念",
  "characters": [
    {
      "name": "姓名",
      "age": "年龄",
      "gender": "性别",
      "height": "身高",
      "identity": "身份",
      "mood": "性格气质",
      "look": "外貌",
      "hair": "发型",
      "clothes": "服装",
      "props": "道具",
      "extra": "其他特征"
    }
  ]
}
characters必须是数组。
`;

    const prompt = `
【故事内容】
${story}

【单集总时长】
${duration}秒

【题材】
${genre}

请生成完整剧本，并提取全部重要人物资料。
剧本需要包含具体场景、人物动作、对白、镜头建议和结尾悬念。
`;

    const response = await generateWithRetry(ai, {
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        systemInstruction
      }
    });

    const parsed = parseModelJson(response.text);
    const script = cleanText(parsed.script, 90000);

    if (!script) throw new Error("AI没有生成有效剧本内容");

    const characters = (Array.isArray(parsed.characters) ? parsed.characters : [])
      .filter(c => c && cleanText(c.name, 80))
      .map(normalizeCharacter);

    return res.json({
      ok: true,
      result: script,
      characters,
      characterCount: characters.length,
      duration,
      durationUnit: "seconds",
      model: MODEL
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

// =====================================
// 自动分镜：按指定时长精确规划镜头
// =====================================

app.post("/api/storyboard", async (req, res) => {
  try {
    const script = cleanText(req.body?.script, 90000);
    const episodeDuration = Number(req.body?.episodeDuration);
    const clipDuration = Number(req.body?.clipDuration);
    const genre = cleanText(req.body?.genre || "都市短剧", 100);

    if (!script) {
      return res.status(400).json({ ok: false, error: "请先生成或填写剧本" });
    }

    if (![60, 90, 120].includes(episodeDuration)) {
      return res.status(400).json({ ok: false, error: "单集时长必须为60、90或120秒" });
    }

    if (![5, 10, 15].includes(clipDuration)) {
      return res.status(400).json({ ok: false, error: "单段视频时长必须为5、10或15秒" });
    }

    if (episodeDuration % clipDuration !== 0) {
      return res.status(400).json({ ok: false, error: "单集时长必须能被单段时长整除" });
    }

    const shotCount = episodeDuration / clipDuration;

    const characters = Array.isArray(req.body?.characters)
      ? req.body.characters.slice(0, 30).map(c => ({
          name: cleanText(c.name, 80),
          age: cleanText(c.age, 30),
          gender: cleanText(c.gender, 20),
          identity: cleanText(c.identity, 300),
          mood: cleanText(c.mood, 300),
          look: cleanText(c.look, 500),
          hair: cleanText(c.hair, 300),
          clothes: cleanText(c.clothes, 500),
          props: cleanText(c.props, 300),
          extra: cleanText(c.extra, 300)
        }))
      : [];

    const scenes = Array.isArray(req.body?.scenes)
      ? req.body.scenes.slice(0, 30).map(s => ({
          name: cleanText(s.name, 100),
          type: cleanText(s.type, 100),
          time: cleanText(s.time, 100),
          desc: cleanText(s.desc, 800)
        }))
      : [];

    const ai = await getAI();

    const systemInstruction = `
你是一名专业的真人短剧导演、分镜师和AI视频提示词工程师。

你的任务是把完整剧本拆成精确数量的独立视频镜头。

必须遵守：
1. 必须返回指定数量的镜头，不能多也不能少。
2. 每个镜头时长必须严格等于指定时长。
3. 镜头按剧情发生顺序排列。
4. 镜头之间人物、服装、发型、道具和场景保持连续一致。
5. 不得擅自改变人物身份、外貌或服装。
6. 每个镜头都必须能独立用于AI视频生成。
7. 不要把多个无关地点或时间跳跃硬塞进同一个镜头。
8. 对白要适合该镜头时长，避免台词过长。
9. 不得凭空增加重要人物。
10. 优先使用用户提供的人物档案和场景档案。
11. 没有对应场景档案时，可以根据剧本描述场景，但要保持前后统一。
12. 视频提示词必须描述主体、人物外观、动作、表情、环境、镜头运动、光线和画面风格。
13. 提示词中要强调真人影视写实风格、人物连续性和自然动作。
14. 每个镜头应有明确的开场状态和结束状态，方便后续剪辑衔接。

只能输出合法JSON，不要输出Markdown和解释。

JSON格式：
{
  "title": "本集名称",
  "summary": "本集分镜概述",
  "shots": [
    {
      "shotNumber": 1,
      "duration": 10,
      "shotTitle": "镜头标题",
      "sceneName": "场景名称",
      "characters": ["人物姓名"],
      "visual": "画面内容和构图",
      "action": "人物动作和表情变化",
      "dialogue": "对白，没有对白写无",
      "camera": "景别、机位和运镜方式",
      "audio": "环境音、音效或音乐建议",
      "continuity": "与前后镜头衔接时必须保持的细节",
      "videoPrompt": "完整、可直接复制到AI视频平台的中文视频生成提示词"
    }
  ]
}
`;

    const prompt = `
【题材】
${genre}

【整集总时长】
${episodeDuration}秒

【每段视频时长】
${clipDuration}秒

【必须生成的镜头数量】
${shotCount}个

【剧本】
${script}

【现有人物档案】
${JSON.stringify(characters, null, 2)}

【现有场景档案】
${JSON.stringify(scenes, null, 2)}

请严格按照剧情顺序拆分镜头。

计算要求：
- 镜头数量必须是${shotCount}个。
- 每个镜头必须是${clipDuration}秒。
- 总时长必须正好为${episodeDuration}秒。
- 不允许用一个镜头代替多个镜头。
- 每个镜头的videoPrompt必须完整，不能只写简略描述。
- 同一人物在全部镜头中必须保持同一张脸、发型、体型和服装设定。
- 对白必须符合人物身份和当前剧情。
`;

    const response = await generateWithRetry(ai, {
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        systemInstruction
      }
    });

    const parsed = parseModelJson(response.text);
    const rawShots = Array.isArray(parsed.shots) ? parsed.shots : [];

    if (rawShots.length !== shotCount) {
      throw new Error(
        `AI返回了${rawShots.length}个镜头，但本次要求${shotCount}个。请重新生成。`
      );
    }

    const shots = rawShots.map((shot, index) => ({
      shotNumber: index + 1,
      duration: clipDuration,
      shotTitle: cleanText(shot.shotTitle, 200) || `镜头${index + 1}`,
      sceneName: cleanText(shot.sceneName, 200),
      characters: Array.isArray(shot.characters)
        ? shot.characters.map(x => cleanText(x, 80)).filter(Boolean)
        : [],
      visual: cleanText(shot.visual, 3000),
      action: cleanText(shot.action, 3000),
      dialogue: cleanText(shot.dialogue, 2000),
      camera: cleanText(shot.camera, 2000),
      audio: cleanText(shot.audio, 1000),
      continuity: cleanText(shot.continuity, 2000),
      videoPrompt: cleanText(shot.videoPrompt, 6000)
    }));

    if (shots.some(s => !s.videoPrompt)) {
      throw new Error("部分镜头缺少视频提示词，请重新生成");
    }

    return res.json({
      ok: true,
      title: cleanText(parsed.title, 200) || "AI短剧分镜",
      summary: cleanText(parsed.summary, 3000),
      episodeDuration,
      clipDuration,
      shotCount,
      totalDuration: shots.reduce((sum, s) => sum + s.duration, 0),
      shots,
      model: MODEL
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.listen(PORT, () => {
  console.log(`AI短剧工厂已启动，端口：${PORT}`);
  console.log(`当前 Gemini 模型：${MODEL}`);
});
