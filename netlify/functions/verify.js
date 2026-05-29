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

  const action = event.queryStringParameters.action;
  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // 1. 获取微软正版设备配对码 (直连 live.com 官方 remoteconnect 通道)
  if (action === 'get_code') {
    try {
      const res = await fetch("https://login.live.com/oauth20_connect.srf", {
        method: "POST",
        headers: { 
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": userAgent
        },
        body: new URLSearchParams({
          client_id: "00000000402B5328",
          scope: "XboxLive.signin offline_access",
          response_type: "code"
        }).toString()
      });

      const data = await res.json();
      if (!res.ok) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ success: false, message: "获取微软设备码失败", details: data })
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          user_code: data.user_code,
          device_code: data.device_code,
          verification_uri: data.verification_uri || "https://login.live.com/oauth20_remoteconnect.srf"
        })
      };
    } catch (e) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ success: false, message: "网络异常", details: e.message })
      };
    }
  }

  // 2. 轮询检测玩家登录状态并执行 Mojang 链条绑定
  if (action === 'poll') {
    const deviceCode = event.queryStringParameters.device_code;
    if (!deviceCode) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, message: "缺少 device_code 参数" })
      };
    }

    try {
      const tokenRes = await fetch("https://login.live.com/oauth20_token.srf", {
        method: "POST",
        headers: { 
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": userAgent
        },
        body: new URLSearchParams({
          client_id: "00000000402B5328",
          grant_type: "device_code",
          device_code: deviceCode
        }).toString()
      });

      const tokenData = await tokenRes.json();

      if (!tokenRes.ok) {
        // 用户还未输入验证码，返回 pending 状态，前端继续等待
        if (tokenData.error === "authorization_pending") {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, status: "pending" })
          };
        }
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ success: false, message: "微软验证轮询失败", details: tokenData.error_description || tokenData.error })
        };
      }

      const msaToken = tokenData.access_token;

      // 3. 用 msaToken 换取 Xbox Live 签名凭证 (XBL)
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
          body: JSON.stringify({ success: false, message: "步骤 2：Xbox Live 认证失败", details: errData })
        };
      }
      const xblData = await xblRes.json();
      const xblToken = xblData.Token;

      // 4. 换取 XSTS 安全凭证
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
        const errData = await xstsRes.json().catch(() => ({}));
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ success: false, message: "步骤 3：XSTS 授权失败", details: errData })
        };
      }
      const xstsData = await xstsRes.json();
      const xstsToken = xstsData.Token;
      const userHash = xstsData.DisplayClaims.xui[0].uhs;

      // 5. 用 XSTS 令牌登录 Minecraft 官方服务
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

      // 6. 获取玩家正版 Profile
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
          status: "success",
          username: mcProfile.name,
          uuid: mcProfile.id
        })
      };

    } catch (e) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ success: false, message: "轮询处理异常", details: e.message })
      };
    }
  }

  return {
    statusCode: 400,
    headers,
    body: JSON.stringify({ success: false, message: "未知动作" })
  };
};
