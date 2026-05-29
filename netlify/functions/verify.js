// netlify/functions/verify.js
exports.handler = async function (event, context) {
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
  const codeVerifier = event.queryStringParameters.code_verifier; // 接收前端的 PKCE 密钥子

  if (!code) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ success: false, message: "缺少 code 授权参数" })
    };
  }

  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  try {
    // 1. 兑换微软官方 access_token (附带 PKCE verifier 校验)
    const tokenBody = {
      client_id: "00000000402B5328",
      code: code,
      grant_type: "authorization_code",
      redirect_uri: "https://login.live.com/oauth20_desktop.srf"
    };

    if (codeVerifier) {
      tokenBody.code_verifier = codeVerifier;
    }

    const tokenRes = await fetch("https://login.live.com/oauth20_token.srf", {
      method: "POST",
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent
      },
      body: new URLSearchParams(tokenBody)
    });

    if (!tokenRes.ok) {
      const errData = await tokenRes.text();
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, message: "步骤 1：微软兑换 Token 失败", details: errData })
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
      const errData = await xblRes.text();
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, message: "步骤 2：Xbox 鉴权失败", details: errData })
      };
    }
    const xblData = await xblRes.json();
    const xblToken = xblData.Token;

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
      const errData = await xstsRes.text();
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, message: "步骤 3：XSTS 授权失败（可能未设置 Xbox 档案）", details: errData })
      };
    }
    const xstsData = await xstsRes.json();
    const xstsToken = xstsData.Token;
    const userHash = xstsData.DisplayClaims.xui[0].uhs;

    // 4. 用 XSTS 令牌登录 Minecraft 官方服务
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
        body: JSON.stringify({ success: false, message: "步骤 4：登录 Minecraft 官方服务失败", details: errData })
      };
    }
    const mcLoginData = await mcLoginRes.json();
    const mcToken = mcLoginData.access_token;

    // 5. 获取正版 Profile
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
        body: JSON.stringify({ success: false, message: "步骤 5：此微软账号未购买官方正版 Minecraft！" })
      };
    }
    if (!profileRes.ok) {
      const errData = await profileRes.text();
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, message: "步骤 5：无法从 Mojang 获取正版 ID 档案", details: errData })
      };
    }
    const mcProfile = await profileRes.json();

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
      body: JSON.stringify({ success: false, message: "云函数运行异常", details: error.message })
    };
  }
};
