import "@supabase/functions-js/edge-runtime.d.ts"
import { withSupabase } from "@supabase/server"

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
}

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function requestHeader(req: Request, name: string) {
  return req.headers.get(name)?.trim() ?? ""
}

function runtimePublishableKey() {
  const encoded = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")
  if (encoded) {
    try {
      const keys = JSON.parse(encoded) as Record<string, unknown>
      const candidate = keys.default ?? Object.values(keys)[0]
      if (typeof candidate === "string" && candidate) return candidate
    } catch {
      // The request apikey remains the preferred source; malformed fallback is ignored.
    }
  }
  return Deno.env.get("SUPABASE_ANON_KEY") ?? ""
}
async function authorize(req: Request, body: Record<string, unknown>) {
  const projectUrl = Deno.env.get("SUPABASE_URL")
  const publishableKey = requestHeader(req, "apikey") || runtimePublishableKey()
  const authorization = requestHeader(req, "authorization")
  if (!projectUrl || !publishableKey || !authorization) throw new Error("BROKER_CONFIGURATION_INVALID")

  const response = await fetch(`${projectUrl}/rest/v1/rpc/authorize_order_storage`, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      authorization,
      "content-type": "application/json",
      "x-device-id": requestHeader(req, "x-device-id"),
      "x-device-token": requestHeader(req, "x-device-token"),
    },
    body: JSON.stringify({
      p_order_id: body.orderId,
      p_operation: body.operation,
      p_sha256: body.sha256 ?? null,
    }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`AUTHORIZATION_FAILED:${response.status}:${payload?.code ?? "unknown"}`)
  return payload as { bucket: string; objectPath: string; operation: string; expiresIn: number }
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") return reply(405, { ok: false, code: "METHOD_NOT_ALLOWED" })
    if (!requestHeader(req, "x-device-id") || !requestHeader(req, "x-device-token")) {
      return reply(401, { ok: false, code: "DEVICE_CREDENTIAL_REQUIRED" })
    }
    const declaredLength = Number(req.headers.get("content-length") || 0)
    if (declaredLength > 4096) return reply(413, { ok: false, code: "REQUEST_TOO_LARGE" })

    try {
      const body = await req.json() as Record<string, unknown>
      if (typeof body.orderId !== "string" || !["upload", "download"].includes(String(body.operation))) {
        return reply(400, { ok: false, code: "INVALID_REQUEST" })
      }
      const authorization = await authorize(req, body)
      if (authorization.operation === "upload") {
        const { data, error } = await ctx.supabaseAdmin.storage
          .from(authorization.bucket)
          .createSignedUploadUrl(authorization.objectPath)
        if (error) throw error
        return reply(200, {
          ok: true,
          operation: "upload",
          bucket: authorization.bucket,
          objectPath: authorization.objectPath,
          signedUrl: data.signedUrl,
          token: data.token,
          expiresIn: authorization.expiresIn,
        })
      }

      const { data, error } = await ctx.supabaseAdmin.storage
        .from(authorization.bucket)
        .createSignedUrl(authorization.objectPath, authorization.expiresIn, { download: false })
      if (error) throw error
      return reply(200, {
        ok: true,
        operation: "download",
        bucket: authorization.bucket,
        objectPath: authorization.objectPath,
        signedUrl: data.signedUrl,
        expiresIn: authorization.expiresIn,
      })
    } catch (error) {
      console.error("storage-broker failed", error instanceof Error ? error.name : "unknown")
      return reply(403, { ok: false, code: "STORAGE_ACCESS_DENIED" })
    }
  }),
}
