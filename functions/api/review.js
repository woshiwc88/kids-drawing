// 豆豆的画板 · 小精灵点评接口
// POST /api/review  Body: { "description": "画里有什么……" }
// 返回：{ "review": "……" }
//
// DeepSeek API Key 通过 Cloudflare Pages 环境变量注入（DEEPSEEK_API_KEY），
// 绝不出现在代码、仓库和浏览器里。Key 未配置时返回 503，前端自动降级为本地点评。

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-chat";

// 小精灵人设：给 6 岁小女孩的画的点评。
// 风格对标迪士尼动画旁白：温暖、奇妙、带一点俏皮；每次都要换花样，不允许套路化。
const SYSTEM_PROMPT = [
  "你是一只住在彩虹云朵上的小精灵，叫「亮晶晶」，最喜欢趴在云朵边看小朋友画画。",
  "现在你要给 6 岁小女孩豆豆的新画说一段话。",
  "",
  "【风格】像迪士尼动画里温柔又俏皮的旁白：有魔法感、有童心、让人嘴角上扬。",
  "",
  "【内容要求】",
  "1. 从画里真实存在的 1~2 样东西出发，编一个小小的魔法瞬间——让它们活过来：小马可能在踮着脚尖跳舞，蛋糕可能在偷偷许愿。只许用画里有的东西，不许瞎编。",
  "2. 夸要夸得具体、真诚，像发现了一件了不得的宝物（比如某种颜色搭配、某个出人意料的组合），绝不说任何缺点。",
  "3. 可以自然地带一点拟声词或语气词（咻——、叮铃、咕噜咕噜），但别堆砌。",
  "4. 结尾留一个轻轻的互动：一个天真小问题，或一个小小邀请（比如「下次想不想看看它飞起来的样子？」）。",
  "",
  "【变化要求——非常重要】",
  "5. 每一次点评都必须和上一次不一样：换一个开场（惊叹、悄悄话、小提问、倒吸一口气……随机选），换一个角度，换一个结尾形式。禁止使用「哇——」「天呐」之外你最近一次用过的开场词。",
  "6. 句式要长短错落，像讲故事一样有呼吸感，不要「首先/然后/最后」，不要分点。",
  "",
  "【硬性规则】",
  "7. 全文 60~110 个汉字，口语化，软萌但有画面感。",
  "8. emoji 用 0~3 个，可不用；禁止英文、说教、恐怖、广告、网络烂梗。"
].join("\n");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let desc = "";
  try {
    const body = await request.json();
    desc = String((body && body.description) || "").slice(0, 1500).trim();
  } catch (e) {
    return json({ error: "bad_request" }, 400);
  }
  if (!desc) return json({ error: "empty_description" }, 400);

  if (!env.DEEPSEEK_API_KEY) return json({ error: "no_api_key" }, 503);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.DEEPSEEK_API_KEY
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: "豆豆的画是这样的：" + desc }
        ],
        temperature: 1.2,
        max_tokens: 300,
        stream: false
      })
    });
    if (!resp.ok) return json({ error: "upstream_" + resp.status }, 502);

    const data = await resp.json();
    const review = data && data.choices && data.choices[0] &&
      data.choices[0].message && String(data.choices[0].message.content || "").trim();
    if (!review) return json({ error: "empty_review" }, 502);

    return json({ review: review.slice(0, 600) });
  } catch (e) {
    return json({ error: e && e.name === "AbortError" ? "timeout" : "upstream_error" }, 502);
  } finally {
    clearTimeout(timer);
  }
}

// 其他方法一律拒绝
export async function onRequest(context) {
  if (context.request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  return onRequestPost(context);
}
