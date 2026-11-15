
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
  if (!apiKey) {
    throw new Error("Render 环境变量中没有设置 GEMINI_API_KEY");
  }

  const { GoogleGenAI } = await import("@google/genai");
  aiClient = new GoogleGenAI({ apiKey });
  return aiClient;
}

function cleanText(value, maxLength = 5000) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
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
    "503",
    "unavailable",
    "high demand",
    "429",
    "resource_exhausted",
    "500",
    "internal server error",
    "502",
    "504"
  ].some(x => message.includes(x));
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

function normalizePeople(list) {
  if (!Array.isArray(list)) return [];

  return list.slice(0, 40).map(c => normalizeCharacter(c));
}

function normalizeScenes(list) {
  if (!Array.isArray(list)) return [];

  return list.slice(0, 40).map(s => ({
    name: cleanText(s.name, 100),
    type: cleanText(s.type, 100),
    time: cleanText(s.time, 100),
    desc: cleanText(s.desc, 1200)
  }));
}

function normalizeShots(list) {
  if (!Array.isArray(list)) return [];

  return list.slice(0, 50).map((s, index) => ({
    shotNumber: Number(s.shotNumber) || index + 1,
    duration: Number(s.duration) || 0,
    shotTitle: cleanText(s.shotTitle, 200),
    sceneName: cleanText(s.sceneName, 200),
    characters: Array.isArray(s.characters)
      ? s.characters.map(x => cleanText(x, 80)).filter(Boolean)
      : [],
    visual: cleanText(s.visual, 2000),
    action: cleanText(s.action, 2000),
    dialogue: cleanText(s.dialogue, 1000),
    camera: cleanText(s.camera, 1000),
    continuity: cleanText(s.continuity, 1500)
  }));
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    message: "AI短剧工厂第三阶段服务运行正常",
    model: MODEL,
    features: [
      "script",
      "storyboard",
      "seedream-image-prompts"
    ]
  });
});

// =====================================
// 第一阶段：剧本生成
// =====================================

app.post("/api/generate", async (req, res) => {
  try {
    const story = cleanText(req.body?.story, 10000);
    const duration = Number(req.body?.duration || 60);
    const genre = cleanText(req.body?.genre || "都市短剧", 100);

    if (!story) {
      return res.status(400).json({
        ok: false,
        error: "请先填写故事内容"
      });
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
  "script": "完整剧本",
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

    if (!script) {
      throw new Error("AI没有生成有效剧本内容");
    }

    const characters = (
      Array.isArray(parsed.characters) ? parsed.characters : []
    )
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
// 第二阶段：自动分镜
// =====================================

app.post("/api/storyboard", async (req, res) => {
  try {
    const script = cleanText(req.body?.script, 90000);
    const episodeDuration = Number(req.body?.episodeDuration);
    const clipDuration = Number(req.body?.clipDuration);
    const genre = cleanText(req.body?.genre || "都市短剧", 100);

    if (!script) {
      return res.status(400).json({
        ok: false,
        error: "请先生成或填写剧本"
      });
    }

    if (![60, 90, 120].includes(episodeDuration)) {
      return res.status(400).json({
        ok: false,
        error: "单集时长必须为60、90或120秒"
      });
    }

    if (![5, 10, 15].includes(clipDuration)) {
      return res.status(400).json({
        ok: false,
        error: "单段视频时长必须为5、10或15秒"
      });
    }

    if (episodeDuration % clipDuration !== 0) {
      return res.status(400).json({
        ok: false,
        error: "单集时长必须能被单段时长整除"
      });
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

任务：将完整剧本拆成精确数量的独立视频镜头。

必须遵守：
1. 必须返回指定数量的镜头。
2. 每个镜头时长严格等于指定时长。
3. 镜头按剧情顺序排列。
4. 人物、服装、发型、道具和场景保持连续一致。
5. 不得擅自改变人物身份、外貌或服装。
6. 每个镜头都能独立用于AI视频生成。
7. 对白要适合镜头时长。
8. 不得凭空增加重要人物。
9. 优先使用用户提供的人物档案和场景档案。
10. 视频提示词必须描述主体、人物外观、动作、表情、环境、运镜、光线和画面风格。
11. 强调真人影视写实风格、人物连续性和自然动作。
12. 每个镜头应有明确开场状态和结束状态。

只能输出合法JSON。

格式：
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
      "action": "人物动作和表情",
      "dialogue": "对白",
      "camera": "景别、机位和运镜方式",
      "audio": "声音设计",
      "continuity": "连续性要求",
      "videoPrompt": "完整中文视频提示词"
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
- 每个镜头的videoPrompt必须完整。
- 同一人物必须保持同一张脸、发型、体型和服装。
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

// =====================================
// 第三阶段：Seedream 4.5 生图提示词中心
// =====================================

app.post("/api/image-prompts", async (req, res) => {
  try {
    const script = cleanText(req.body?.script, 90000);
    const genre = cleanText(req.body?.genre || "都市短剧", 100);
    const category = cleanText(req.body?.category || "all", 30);

    const allowedCategories = [
      "all",
      "character",
      "scene",
      "prop",
      "keyframe",
      "storyboard"
    ];

    if (!allowedCategories.includes(category)) {
      return res.status(400).json({
        ok: false,
        error: "不支持的生图提示词类型"
      });
    }

    const characters = normalizePeople(req.body?.characters);
    const scenes = normalizeScenes(req.body?.scenes);
    const shots = normalizeShots(req.body?.shots);

    if (
      !script &&
      characters.length === 0 &&
      scenes.length === 0 &&
      shots.length === 0
    ) {
      return res.status(400).json({
        ok: false,
        error: "请先提供剧本、人物档案、场景档案或分镜资料"
      });
    }

    const ai = await getAI();

    const systemInstruction = `
你是一名专业的电影美术指导、真人影视角色设计师、
场景概念设计师、道具设计师，以及豆包 Seedream 4.5 中文提示词工程师。

你的任务是根据用户提供的剧本、人物档案、场景档案和分镜，
生成可以直接复制到豆包 Seedream 4.5 使用的高质量中文图片提示词。

【整体视觉标准】
1. 真人影视剧摄影质感，不是动漫，不是插画，不是游戏建模。
2. 真实人物皮肤纹理、自然五官比例、真实材质。
3. 画面构图清楚，主体明确，细节丰富。
4. 具体描述景别、机位、光线、色彩、环境和视觉重点。
5. 提示词使用完整自然中文，不要只堆砌关键词。
6. 不要让图片中出现乱码、随机文字、字幕、水印或Logo。
7. 不要虚构用户档案中已经明确的人物身份和外貌。
8. 同一人物必须保持相同脸型、五官、肤色、年龄感、体型和发型。
9. 已有服装设定时，不能擅自换装。
10. 同一场景必须保持空间布局、家具位置和光线方向一致。
11. 同一道具必须保持颜色、结构、材质和形状一致。
12. 人物、场景和道具需要建立可重复使用的视觉设定。

【人物提示词要求】
- 生成真人影视演员定妆照。
- 描述脸型、眉眼、鼻子、嘴唇、肤色、年龄感、体型。
- 描述发型、发色、服装、鞋子、首饰和配饰。
- 提供正面、45度、左右侧面、背面、全身和面部特写等视图。
- 多视图中必须是同一个人。
- 说明建议上传人物参考图。

【场景提示词要求】
- 描述空间结构、门窗、家具、墙面、地面和装饰。
- 描述时间、天气、光源方向、明暗关系和色彩。
- 优先生成没有人物的纯场景参考图。
- 同一个场景不同角度必须保持空间布局一致。

【道具提示词要求】
- 一件道具单独展示，主体完整清楚。
- 描述形状、结构、颜色、材质、尺寸比例和磨损细节。
- 采用专业产品摄影或影视道具设计图质感。
- 不要无关物品堆叠，不要人物手部遮挡主体。

【剧情关键画面要求】
- 从剧情中寻找最重要的冲突、打脸、反转、揭露身份和情绪爆发画面。
- 描述人物位置、动作、表情、视线、景别和环境。
- 画面必须能体现剧情瞬间，不要只写抽象情绪。

【分镜参考图要求】
- 每个分镜生成一张静态关键帧。
- 画面内容与对应视频镜头一致。
- 明确人物位置、动作发生瞬间、镜头角度和背景。
- 不要把静态画面写成连续视频。

【提示词质量】
每条prompt都要足够详细，可以直接复制使用。
每条referenceGuide说明需要上传什么参考图片。
每条consistency说明生成后需要重点检查什么。
每条negativePrompt描述应该避免的视觉问题。

只能输出合法JSON，不要输出Markdown或其他解释。

JSON格式：
{
  "title": "生图提示词方案名称",
  "summary": "生成内容概述",
  "prompts": [
    {
      "id": "唯一编号",
      "category": "character",
      "title": "提示词标题",
      "subject": "对应人物、场景、道具或镜头名称",
      "purpose": "用途说明",
      "prompt": "完整详细中文生图提示词",
      "referenceGuide": "参考图上传说明",
      "consistency": "一致性要求",
      "negativePrompt": "负面约束词",
      "aspectRatio": "建议画幅比例"
    }
  ]
}

category只能使用：
character、scene、prop、keyframe、storyboard。

每条提示词必须完整，不能用“同上”或省略内容。
`;

    const prompt = `
【当前题材】
${genre}

【需要生成的类别】
${category === "all" ? "全部五种类别" : category}

【剧本内容】
${script || "用户尚未提供完整剧本，请根据档案生成可用的视觉设定。"}

【人物档案】
${JSON.stringify(characters, null, 2)}

【场景档案】
${JSON.stringify(scenes, null, 2)}

【分镜档案】
${JSON.stringify(shots, null, 2)}

请根据现有资料生成 Seedream 4.5 生图提示词。

生成规则：
1. 有人物档案时，为每个人物生成独立的定妆提示词。
2. 有场景档案时，为每个场景生成独立场景提示词。
3. 从剧本中识别具有剧情作用的重要道具，为每件道具生成独立提示词。
4. 从剧本中识别重要剧情瞬间，生成关键画面提示词。
5. 有分镜资料时，为每个分镜生成独立静态参考图提示词。
6. 不要把多个不同人物合并成一张定妆图。
7. 不要把多个不同道具合并成一张道具图。
8. 没有具体资料的内容可以根据剧情合理补充，但不能与现有档案冲突。
9. 所有提示词都必须使用中文。
10. 每条提示词都必须能独立复制使用。
`;

    const response = await generateWithRetry(ai, {
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        systemInstruction
      }
    });

    const parsed = parseModelJson(response.text);

    const rawPrompts = Array.isArray(parsed.prompts)
      ? parsed.prompts
      : [];

    if (!rawPrompts.length) {
      throw new Error("AI没有生成有效的生图提示词");
    }

    const validCategories = [
      "character",
      "scene",
      "prop",
      "keyframe",
      "storyboard"
    ];

    const prompts = rawPrompts
      .slice(0, 100)
      .map((item, index) => ({
        id: cleanText(item.id, 100) || `prompt-${index + 1}`,
        category: validCategories.includes(item.category)
          ? item.category
          : "keyframe",
        title: cleanText(item.title, 200) || `生图提示词${index + 1}`,
        subject: cleanText(item.subject, 200),
        purpose: cleanText(item.purpose, 500),
        prompt: cleanText(item.prompt, 12000),
        referenceGuide: cleanText(item.referenceGuide, 2000),
        consistency: cleanText(item.consistency, 2000),
        negativePrompt: cleanText(item.negativePrompt, 2000),
        aspectRatio: cleanText(item.aspectRatio, 30) || "16:9"
      }))
      .filter(item => item.prompt);

    if (!prompts.length) {
      throw new Error("AI返回的提示词内容为空");
    }

    return res.json({
      ok: true,
      title: cleanText(parsed.title, 200) || "Seedream 4.5 生图提示词",
      summary: cleanText(parsed.summary, 3000),
      promptCount: prompts.length,
      prompts,
      model: MODEL
    });

  } catch (error) {
    return errorResponse(res, error);
  }
});

// =====================================
// 启动服务
// =====================================

app.listen(PORT, () => {
  console.log(`AI短剧工厂第三阶段已启动，端口：${PORT}`);
  console.log(`当前 Gemini 模型：${MODEL}`);
});
