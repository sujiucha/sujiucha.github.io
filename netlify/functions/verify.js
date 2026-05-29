// netlify/functions/verify.js
exports.handler = async function (event, context) {
  // 允许跨域请求头设置，确保任何地方的网页都能正常调用
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json;charset=utf-8'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const code = event.queryStringParameters.code;
  if (!code) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ success: false, message: "缺少 code 授权参数" })
    };
  }

  // ⚡ 核心欺骗伪装：高等级 Windows Chrome 浏览器标识（Mojang 安全盾白名单）
  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  try {
    // 1. 兑换微软官方 access_token
    const tokenRes = await fetch("https://login.live.com/oauth20_token.srf", {
      method: "POST",
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent
      },
      body: new URLSearchParams({
        client_id: "00000000402B5328",
        code: code,
        grant_type: "authorization_code",
        redirect_uri: "https://login.live.com/oauth20_desktop.srf"
      })
    });

    if (!tokenRes.ok) {
      const errData = await tokenRes.text();
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, message: "微软兑换 Token 失败", details: errData })
      };
    }
    const tokenData = await tokenRes.json();
    const msaToken = tokenData.access_token;

    // 2. 用 msaToken 换取 Xbox Live 签名凭证 (XBL)
    const xblRes = await fetch("https://user.auth.xboxlive.com/user/authenticate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": userAgent
      },
      body: JSON.stringify({
        Properties: {
          AuthMethod: "RPS",
          SiteName: "user.auth.xboxlive.com",
          RpsTicket: `d=${msaToken}`
        },
        RelyingParty: "http://auth.xboxlive.com",
        TokenType: "JWT"
      })
    });

    if (!xblRes.ok) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, message: "Xbox 鉴权失败，未注册 Xbox 档案！" })
      };
    }
    const xblData = await xblRes.json();
    const xblToken = xblData.Token;
    const userHash = xblData.DisplayClaims.xui[0].uhs;

    // 3. 换取 XSTS 安全凭证
    const xstsRes = await fetch("https://xsts.auth.xboxlive.com/xsts/authorize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": userAgent
      },
      body: JSON.stringify({
        Properties: {
          SandboxId: "RETAIL",
          UserTokens: [xblToken]
        },
        RelyingParty: "rp://api.minecraftservices.com/",
        TokenType: "JWT"
      })
    });

    if (!xstsRes.ok) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, message: "微软防沉迷家长策略拦截或账号地区限制，XSTS 授权失败。" })
      };
    }
    const xstsData = await xstsRes.json();
    const xstsToken = xstsData.Token;

    // 4. 用 XSTS 令牌登录 Minecraft 官方服务 (注入 UA 欺骗 Mojang 防火墙)
    const mcLoginRes = await fetch("https://api.minecraftservices.com/authentication/login_with_xbox", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": userAgent
      },
      body: JSON.stringify({
        identityToken: `XSTS=uhs:${userHash};${xstsToken}`
      })
    });

    if (!mcLoginRes.ok) {
      const errData = await mcLoginRes.text();
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, message: "登录 Minecraft 官方服务失败", details: errData })
      };
    }
    const mcLoginData = await mcLoginRes.json();
    const mcToken = mcLoginData.access_token;

    // 5. 获取正版 Profile (注入 UA 欺骗 Mojang 防火墙)
    const profileRes = await fetch("https://api.minecraftservices.com/minecraft/profile", {
      method: "GET",
      headers: { 
        "Authorization": `Bearer ${mcToken}`,
        "User-Agent": userAgent
      }
    });

    if (profileRes.status === 404) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ success: false, message: "此微软账号未购买官方正版 Minecraft！" })
      };
    }
    if (!profileRes.ok) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, message: "无法从 Mojang 获取正版 ID 档案" })
      };
    }
    const mcProfile = await profileRes.json();

    // 6. 成功返回正版玩家名与 UUID
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        username: mcProfile.name,
        uuid: mcProfile.id
      })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, message: error.message })
    };
  }
};
