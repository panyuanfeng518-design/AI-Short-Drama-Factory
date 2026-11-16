
// =====================================
// Gemini 错误识别与智能重试 V2
// 429额度错误不重试，服务器故障才重试
// =====================================

function getErrorStatus(error) {
  const status = Number(error?.status || error?.code);

  if (status) return status;

  const message = String(error?.message || error || "");

  const match = message.match(/"code"\s*:\s*(\d{3})/);

  return match ? Number(match[1]) : 0;
}

function getErrorMessage(error) {
  return String(error?.message || error || "");
}

function isQuotaExceeded(error) {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("resource_exhausted") ||
    message.includes("quota exceeded") ||
    message.includes("per day limit exceeded") ||
    message.includes("generate_content_free_tier_requests")
  );
}

function getRetryDelaySeconds(error) {
  const message = getErrorMessage(error);

  const match = message.match(/retryDelay["']?\s*:\s*["']?(\d+(?:\.\d+)?)s/i);

  if (match) {
    return Math.ceil(Number(match[1]));
  }

  return 0;
}

// 只把真正的服务器故障视为可重试错误
function isRetryableServerError(error) {
  const status = getErrorStatus(error);

  if ([500, 502, 503, 504].includes(status)) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();

  return [
    "econnreset",
    "etimedout",
    "socket hang up",
    "temporarily unavailable"
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

      const status = getErrorStatus(error);
      const quota = isQuotaExceeded(error);

      console.error(
        `Gemini 第 ${attempt} 次请求失败，HTTP状态：${status}`,
        getErrorMessage(error)
      );

      // 重点：每日额度耗尽，立即停止
      if (quota) {
        console.error(
          "Gemini 每日免费额度已耗尽，停止自动重试。"
        );

        throw error;
      }

      // 所有429都不进行连续重试
      if (status === 429) {
        console.error(
          "Gemini 请求频率或额度受限，停止自动重试。"
        );

        throw error;
      }

      // 非服务器故障，不重试
      if (!isRetryableServerError(error)) {
        throw error;
      }

      if (attempt === maxAttempts) {
        throw error;
      }

      // 服务器故障采用逐步延长等待时间
      const waitTime = attempt * 5000;

      console.log(
        `Gemini 服务暂时异常，${waitTime / 1000}秒后重试……`
      );

      await new Promise(resolve =>
        setTimeout(resolve, waitTime)
      );
    }
  }

  throw lastError || new Error("Gemini 请求失败");
}

// =====================================
// 统一错误返回
// =====================================

function errorResponse(res, error) {
  console.error("AI请求失败：", error);

  const message = getErrorMessage(error);
  const status = getErrorStatus(error);

  const quota = isQuotaExceeded(error);
  const retryDelay = getRetryDelaySeconds(error);

  // 每日额度耗尽
  if (quota) {
    const hours = Math.floor(retryDelay / 3600);
    const minutes = Math.ceil((retryDelay % 3600) / 60);

    let waitText = "";

    if (retryDelay > 0) {
      waitText = `预计约${hours > 0 ? hours + "小时" : ""}${minutes}分钟后恢复。`;
    }

    return res.status(429).json({
      ok: false,
      code: "GEMINI_DAILY_QUOTA_EXCEEDED",
      error: "Gemini API 每日免费请求额度已用完。",
      detail: message,
      retryAfterSeconds: retryDelay,
      suggestion: waitText || "请稍后检查 Gemini API 额度。",
      model: MODEL
    });
  }

  // 请求频率限制
  if (status === 429) {
    return res.status(429).json({
      ok: false,
      code: "GEMINI_RATE_LIMITED",
      error: "Gemini 请求频率受限，请稍后再试。",
      detail: message,
      retryAfterSeconds: retryDelay,
      model: MODEL
    });
  }

  // 服务暂时不可用
  if ([500, 502, 503, 504].includes(status)) {
    return res.status(503).json({
      ok: false,
      code: "GEMINI_TEMPORARILY_UNAVAILABLE",
      error: "Gemini 服务暂时不可用，系统已完成有限次数重试。",
      detail: message,
      model: MODEL
    });
  }

  return res.status(status >= 400 && status < 600 ? status : 500).json({
    ok: false,
    code: "AI_REQUEST_FAILED",
    error: message || "AI请求失败，请检查服务配置。",
    detail: message,
    model: MODEL
  });
}
