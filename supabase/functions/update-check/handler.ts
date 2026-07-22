import "@supabase/functions-js/edge-runtime.d.ts"
import { withSupabase } from "@supabase/server"

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
}
const attempts = new Map<string, number[]>()

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function header(req: Request, name: string) {
  return req.headers.get(name)?.trim() ?? ""
}

function withinRateLimit(key: string) {
  const now = Date.now()
  const recent = (attempts.get(key) ?? []).filter((value) => now - value < 60_000)
  if (recent.length >= 15) return false
  recent.push(now)
  attempts.set(key, recent)
  if (attempts.size > 2_000) {
    for (const [candidate, values] of attempts) {
      if (!values.some((value) => now - value < 60_000)) attempts.delete(candidate)
    }
  }
  return true
}

function validUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.method !== "POST") return reply(405, { ok: false, code: "METHOD_NOT_ALLOWED" })
    if (Number(req.headers.get("content-length") || 0) > 2048) {
      return reply(413, { ok: false, code: "REQUEST_TOO_LARGE" })
    }

    const deviceId = header(req, "x-device-id")
    const deviceToken = header(req, "x-device-token")
    const sourceIp = header(req, "x-forwarded-for").split(",")[0] || "unknown"
    if (!validUuid(deviceId) || deviceToken.length < 32 || deviceToken.length > 256) {
      return reply(401, { ok: false, code: "DEVICE_CREDENTIAL_REQUIRED" })
    }
    if (!withinRateLimit(`${sourceIp}:${deviceId}`)) {
      return reply(429, { ok: false, code: "RATE_LIMITED" })
    }

    try {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      const currentSequence = Number(body.currentSequence ?? 0)
      if (!Number.isSafeInteger(currentSequence) || currentSequence < 0) {
        return reply(400, { ok: false, code: "INVALID_SEQUENCE" })
      }

      const { data, error } = await ctx.supabaseAdmin.schema("api").rpc("edge_check_update", {
        p_device_id: deviceId,
        p_device_token: deviceToken,
        p_current_sequence: currentSequence,
      })
      if (error) throw error
      if (!data?.updateAvailable) return reply(200, { ok: true, updateAvailable: false, serverTime: data?.serverTime })

      const { data: signed, error: signedError } = await ctx.supabaseAdmin.storage
        .from("app-updates")
        .createSignedUrl(data.packagePath, 300, { download: true })
      if (signedError) throw signedError

      return reply(200, {
        ok: true,
        updateAvailable: true,
        releaseSequence: data.releaseSequence,
        minimumSequence: data.minimumSequence,
        manifest: { ...data.canonicalManifest, signature: data.signature },
        packageUrl: signed.signedUrl,
        packageUrlExpiresIn: 300,
        mandatoryAfter: data.mandatoryAfter,
        serverTime: data.serverTime,
      })
    } catch (error) {
      console.error("update-check failed", error instanceof Error ? error.name : "unknown")
      return reply(403, { ok: false, code: "UPDATE_ACCESS_DENIED" })
    }
  }),
}
