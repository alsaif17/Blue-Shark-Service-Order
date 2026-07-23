import "@supabase/functions-js/edge-runtime.d.ts"
import { withSupabase } from "@supabase/server"

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
}

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function header(req: Request, name: string) {
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
async function userRpc(req: Request, functionName: string, body: Record<string, unknown>) {
  const projectUrl = Deno.env.get("SUPABASE_URL")
  const publishableKey = header(req, "apikey") || runtimePublishableKey()
  if (!projectUrl || !publishableKey) throw new Error("ADMIN_CONFIGURATION_INVALID")
  const response = await fetch(`${projectUrl}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      authorization: header(req, "authorization"),
      "content-type": "application/json",
      "x-device-id": header(req, "x-device-id"),
      "x-device-token": header(req, "x-device-token"),
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`RPC_FAILED:${functionName}:${response.status}:${payload?.code ?? "unknown"}`)
  return payload
}

async function requireSystemAdmin(req: Request) {
  const status = await userRpc(req, "session_status", {}) as Record<string, unknown>
  if (status.systemAdmin !== true || status.deviceState !== "approved") {
    throw new Error("SYSTEM_ADMIN_REQUIRED")
  }
}

function validUuid(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") return reply(405, { ok: false, code: "METHOD_NOT_ALLOWED" })
    if (!header(req, "x-device-id") || !header(req, "x-device-token")) {
      return reply(401, { ok: false, code: "DEVICE_CREDENTIAL_REQUIRED" })
    }
    if (Number(req.headers.get("content-length") || 0) > 32768) {
      return reply(413, { ok: false, code: "REQUEST_TOO_LARGE" })
    }

    try {
      await requireSystemAdmin(req)
      const body = await req.json() as Record<string, unknown>
      const action = String(body.action || "")

      if (action === "create") {
        const email = String(body.email || "").trim().toLowerCase()
        const username = String(body.username || "").trim()
        const displayName = String(body.displayName || "").trim()
        const password = String(body.temporaryPassword || "")
        const assignments = Array.isArray(body.assignments) ? body.assignments as Array<Record<string, unknown>> : []
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
          || !/^[A-Za-z0-9._-]{3,64}$/.test(username)
          || displayName.length < 2 || displayName.length > 160
          || password.length < 12 || assignments.length < 1 || assignments.length > 50) {
          return reply(400, { ok: false, code: "INVALID_USER_INPUT" })
        }
        for (const assignment of assignments) {
          if (!validUuid(assignment.branchId) || !["employee", "supervisor"].includes(String(assignment.role))) {
            return reply(400, { ok: false, code: "INVALID_ASSIGNMENT" })
          }
        }

        const { data, error } = await ctx.supabaseAdmin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          app_metadata: { username, display_name: displayName },
        })
        if (error || !data.user) throw error ?? new Error("USER_CREATE_FAILED")

        try {
          for (const assignment of assignments) {
            await userRpc(req, "admin_set_membership", {
              p_user_id: data.user.id,
              p_branch_id: assignment.branchId,
              p_role: assignment.role,
              p_active: true,
            })
          }
        } catch (membershipError) {
          await userRpc(req, "admin_set_user_active", { p_user_id: data.user.id, p_active: false }).catch(() => {})
          await ctx.supabaseAdmin.auth.admin.updateUserById(data.user.id, { ban_duration: "876000h" }).catch(() => {})
          throw membershipError
        }
        return reply(201, { ok: true, userId: data.user.id })
      }

      if (!validUuid(body.userId)) return reply(400, { ok: false, code: "INVALID_USER_ID" })
      const userId = String(body.userId)

      if (action === "disable") {
        await userRpc(req, "admin_set_user_active", { p_user_id: userId, p_active: false })
        const { error } = await ctx.supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: "876000h" })
        if (error) throw error
        return reply(200, { ok: true, userId, active: false })
      }

      if (action === "enable") {
        const { error } = await ctx.supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: "none" })
        if (error) throw error
        await userRpc(req, "admin_set_user_active", { p_user_id: userId, p_active: true })
        return reply(200, { ok: true, userId, active: true })
      }

      if (action === "reset_password") {
        const password = String(body.temporaryPassword || "")
        if (password.length < 12) return reply(400, { ok: false, code: "WEAK_PASSWORD" })
        const { error } = await ctx.supabaseAdmin.auth.admin.updateUserById(userId, { password })
        if (error) throw error
        return reply(200, { ok: true, userId, passwordReset: true })
      }

      return reply(400, { ok: false, code: "UNSUPPORTED_ACTION" })
    } catch (error) {
      console.error("admin-users failed", error instanceof Error ? error.name : "unknown")
      return reply(403, { ok: false, code: "ADMIN_OPERATION_DENIED" })
    }
  }),
}
