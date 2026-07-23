function responseHeaders() {
  const headers = new Headers()
  headers.set("Content-Type", "text/html; charset=UTF-8")
  headers.set("Cache-Control", "no-store, max-age=0")
  headers.set("Content-Security-Policy", [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src https://*.supabase.co",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "))
  headers.set("Referrer-Policy", "no-referrer")
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("X-Frame-Options", "DENY")
  return headers
}

function page(supabaseUrl: string, publishableKey: string, recoveryUrl: string) {
  const runtime = JSON.stringify({ supabaseUrl, publishableKey, recoveryUrl })
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>&#x627;&#x633;&#x62a;&#x639;&#x627;&#x62f;&#x629; &#x643;&#x644;&#x645;&#x629; &#x627;&#x644;&#x645;&#x631;&#x648;&#x631; | Blue Shark</title>
  <style>
    :root{color-scheme:light;--navy:#09243d;--blue:#1173a8;--line:#d8e3eb;--muted:#607080;--ok:#0d7658;--bad:#b42318}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(145deg,#edf6fa,#fff);font-family:Tahoma,Arial,sans-serif;color:var(--navy)}
    main{width:min(92vw,430px);background:#fff;border:1px solid var(--line);border-radius:18px;padding:28px;box-shadow:0 18px 55px #09243d18}
    h1{margin:0 0 8px;font-size:25px}p{line-height:1.7;color:var(--muted);margin:0 0 18px}
    label{display:block;font-weight:700;margin:14px 0 7px}input{width:100%;padding:13px;border:1px solid #b9c9d5;border-radius:10px;font:inherit;direction:ltr}
    button{width:100%;margin-top:18px;padding:13px;border:0;border-radius:10px;background:var(--blue);color:#fff;font:700 16px Tahoma,Arial,sans-serif;cursor:pointer}
    button:disabled{opacity:.55;cursor:wait}.message{display:none;margin-top:16px;padding:12px;border-radius:10px;line-height:1.6}.message.ok{display:block;background:#e9f8f2;color:var(--ok)}.message.bad{display:block;background:#fff0ee;color:var(--bad)}
    .brand{font-weight:800;color:var(--blue);letter-spacing:.4px;margin-bottom:18px}.hidden{display:none}
  </style>
</head>
<body>
<main>
  <div class="brand" dir="ltr">BLUE SHARK</div>
  <section id="request-panel">
    <h1>&#x646;&#x633;&#x64a;&#x62a; &#x643;&#x644;&#x645;&#x629; &#x627;&#x644;&#x645;&#x631;&#x648;&#x631;&#x61f;</h1>
    <p>&#x623;&#x62f;&#x62e;&#x644; &#x628;&#x631;&#x64a;&#x62f;&#x643; &#x627;&#x644;&#x625;&#x644;&#x643;&#x62a;&#x631;&#x648;&#x646;&#x64a; &#x648;&#x633;&#x646;&#x631;&#x633;&#x644; &#x644;&#x643; &#x631;&#x627;&#x628;&#x637;&#x64b;&#x627; &#x622;&#x645;&#x646;&#x64b;&#x627; &#x644;&#x62a;&#x639;&#x64a;&#x64a;&#x646; &#x643;&#x644;&#x645;&#x629; &#x645;&#x631;&#x648;&#x631; &#x62c;&#x62f;&#x64a;&#x62f;&#x629;.</p>
    <form id="request-form">
      <label for="email">&#x627;&#x644;&#x628;&#x631;&#x64a;&#x62f; &#x627;&#x644;&#x625;&#x644;&#x643;&#x62a;&#x631;&#x648;&#x646;&#x64a;</label>
      <input id="email" type="email" autocomplete="email" required>
      <button id="request-button" type="submit">&#x625;&#x631;&#x633;&#x627;&#x644; &#x631;&#x627;&#x628;&#x637; &#x627;&#x644;&#x627;&#x633;&#x62a;&#x639;&#x627;&#x62f;&#x629;</button>
    </form>
  </section>
  <section id="update-panel" class="hidden">
    <h1>&#x62a;&#x639;&#x64a;&#x64a;&#x646; &#x643;&#x644;&#x645;&#x629; &#x645;&#x631;&#x648;&#x631; &#x62c;&#x62f;&#x64a;&#x62f;&#x629;</h1>
    <p>&#x627;&#x62e;&#x62a;&#x631; &#x643;&#x644;&#x645;&#x629; &#x645;&#x631;&#x648;&#x631; &#x642;&#x648;&#x64a;&#x629;&#x60c; &#x62b;&#x645; &#x627;&#x633;&#x62a;&#x62e;&#x62f;&#x645;&#x647;&#x627; &#x644;&#x62a;&#x633;&#x62c;&#x64a;&#x644; &#x627;&#x644;&#x62f;&#x62e;&#x648;&#x644; &#x641;&#x64a; &#x62a;&#x637;&#x628;&#x64a;&#x642; Blue Shark.</p>
    <form id="update-form">
      <label for="password">&#x643;&#x644;&#x645;&#x629; &#x627;&#x644;&#x645;&#x631;&#x648;&#x631; &#x627;&#x644;&#x62c;&#x62f;&#x64a;&#x62f;&#x629;</label>
      <input id="password" type="password" autocomplete="new-password" minlength="12" required>
      <label for="confirmation">&#x62a;&#x623;&#x643;&#x64a;&#x62f; &#x643;&#x644;&#x645;&#x629; &#x627;&#x644;&#x645;&#x631;&#x648;&#x631;</label>
      <input id="confirmation" type="password" autocomplete="new-password" minlength="12" required>
      <button id="update-button" type="submit">&#x62d;&#x641;&#x638; &#x643;&#x644;&#x645;&#x629; &#x627;&#x644;&#x645;&#x631;&#x648;&#x631;</button>
    </form>
  </section>
  <div id="message" class="message" role="status" aria-live="polite"></div>
</main>
<script>
(() => {
  "use strict";
  const config = ${runtime};
  const message = document.getElementById("message");
  const requestPanel = document.getElementById("request-panel");
  const updatePanel = document.getElementById("update-panel");
  let accessToken = "";

  function show(text, ok) {
    message.textContent = text;
    message.className = "message " + (ok ? "ok" : "bad");
  }
  function fragment() {
    return new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
  }
  async function verifyTokenHash() {
    const query = new URLSearchParams(location.search);
    const tokenHash = query.get("token_hash");
    if (!tokenHash) return "";
    const response = await fetch(config.supabaseUrl + "/auth/v1/verify", {
      method: "POST",
      headers: { "apikey": config.publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ token_hash: tokenHash, type: "recovery" })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Error("The recovery link could not be verified. Request a new link.");
    return data.access_token;
  }
  async function initialize() {
    const values = fragment();
    if (values.get("error_description")) {
      show("The recovery link is invalid or expired. Request a new link.", false);
      history.replaceState(null, "", location.pathname);
      return;
    }
    accessToken = values.get("access_token") || await verifyTokenHash();
    if (accessToken) {
      history.replaceState(null, "", location.pathname);
      requestPanel.classList.add("hidden");
      updatePanel.classList.remove("hidden");
    }
  }
  document.getElementById("request-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.getElementById("request-button");
    button.disabled = true;
    message.className = "message";
    try {
      const response = await fetch(config.supabaseUrl + "/auth/v1/recover?redirect_to=" + encodeURIComponent(config.recoveryUrl), {
        method: "POST",
        headers: { "apikey": config.publishableKey, "content-type": "application/json" },
        body: JSON.stringify({ email: document.getElementById("email").value.trim() })
      });
      if (!response.ok) throw new Error("The recovery email could not be sent. Please try again shortly.");
      show("If the email is registered, a recovery message will arrive within a few minutes.", true);
    } catch (error) {
      show(error.message || "The recovery link could not be sent.", false);
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById("update-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = document.getElementById("password").value;
    const confirmation = document.getElementById("confirmation").value;
    if (password !== confirmation) return show("The passwords do not match.", false);
    const button = document.getElementById("update-button");
    button.disabled = true;
    message.className = "message";
    try {
      const response = await fetch(config.supabaseUrl + "/auth/v1/user", {
        method: "PUT",
        headers: {
          "apikey": config.publishableKey,
          "authorization": "Bearer " + accessToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.msg || data.message || "The password could not be changed.");
      accessToken = "";
      document.getElementById("update-form").reset();
      show("Password changed successfully. You can now sign in to Blue Shark.", true);
      button.classList.add("hidden");
    } catch (error) {
      show(error.message || "The password could not be changed.", false);
    } finally {
      button.disabled = false;
    }
  });
  initialize().catch((error) => show(error.message || "The recovery link is invalid.", false));
})();
</script>
</body>
</html>`
}

function defaultPublishableKey() {
  const modernKeys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")
  if (modernKeys) {
    try {
      const parsed = JSON.parse(modernKeys) as Record<string, string>
      if (typeof parsed.default === "string" && parsed.default) return parsed.default
    } catch {
      // Fall back to the legacy publishable anon key when the map is unavailable.
    }
  }
  return Deno.env.get("SUPABASE_ANON_KEY") ?? ""
}

export default {
  async fetch(req: Request) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD", "cache-control": "no-store" },
      })
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
    const publishableKey = defaultPublishableKey()
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) || !publishableKey) {
      return new Response("Service unavailable", { status: 503 })
    }

    const requestUrl = new URL(req.url)
    const recoveryUrl = `${requestUrl.origin}${requestUrl.pathname}`
    const body = req.method === "HEAD" ? null : page(supabaseUrl, publishableKey, recoveryUrl)
    return new Response(body, { status: 200, headers: responseHeaders() })
  },
}
