import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyPassword, hashPassword } from "../security/password.js";
import { requireAuth, requireCsrf, requireRole } from "../auth/auth-plugin.js";

/**
 * Authentication routes.
 * - login: IP rate-limited, timing-equalized, session rotated on success.
 * - logout: revokes the account's sessions.
 * - me: session identity for SPA bootstrap.
 * - users: admin-only account administration with last-admin protection.
 */
const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(512),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z
    .string()
    .min(12, "new password must be at least 12 characters")
    .max(128)
    .refine((v) => /[a-zA-Z]/.test(v) && /\d/.test(v), "use at least one letter and one digit"),
});

const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.-]{3,64}$/, "username must be 3-64 chars [a-zA-Z0-9_.-]"),
  password: z
    .string()
    .min(12, "password must be at least 12 characters")
    .max(128)
    .refine((v) => /[a-zA-Z]/.test(v) && /\d/.test(v), "use at least one letter and one digit"),
  role: z.enum(["admin", "operator", "viewer"]),
});

const updateUserSchema = z
  .object({
    isActive: z.boolean().optional(),
    role: z.enum(["admin", "operator", "viewer"]).optional(),
  })
  .refine((v) => v.isActive !== undefined || v.role !== undefined, "no changes requested");

// A fixed Argon2id hash keeps unknown-user and inactive-user responses
// timing-similar to a wrong-password response.
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$vtX/5Q4ki/gTHOfwi6ALDQ$oO1QDfD2D/hGCyNSyI//d5UWq+3UvYJ2KgpBZXdmeV8";

function noStore(reply: { header(name: string, value: string): unknown }) {
  reply.header("cache-control", "no-store");
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/api/auth/login", {
    config: { rateLimit: { max: 8, timeWindow: "5 minutes" } },
    async handler(request, reply) {
      noStore(reply);
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "username and password are required" });
      }
      const { username, password } = parsed.data;
      const db = fastify.prisma;
      const user = await db.adminUser.findUnique({
        where: { username },
        include: { role: true },
      });
      const activeUser = user && !user.deletedAt && user.isActive ? user : null;
      const ok = await verifyPassword(activeUser?.passwordHash ?? DUMMY_HASH, password);
      const genericError = { error: "invalid credentials", code: "INVALID_CREDENTIALS" };

      if (!activeUser || !ok) {
        await fastify.services.audit.record({
          actorId: activeUser?.id ?? null,
          actorLabel: activeUser?.username ?? "anonymous",
          action: "auth.login_failed",
          targetType: "admin_user",
          targetId: activeUser?.id ?? username,
          meta: { reason: activeUser ? "bad password" : "unknown, deleted, or inactive user" },
          ip: request.ip,
          userAgent: request.headers["user-agent"],
        });
        return reply.status(401).send(genericError);
      }

      // Session rotation: a fresh opaque token on every login.
      await fastify.sessionService.revokeAllForUser(activeUser.id, "rotated by new login");
      const session = await fastify.sessionService.createSession(request, reply, activeUser.id);
      await db.adminUser.update({
        where: { id: activeUser.id },
        data: { lastLoginAt: new Date() },
      });
      await fastify.services.audit.record({
        actorId: activeUser.id,
        actorLabel: activeUser.username,
        action: "auth.login",
        targetType: "admin_user",
        targetId: activeUser.id,
        meta: {},
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
      return {
        user: {
          id: activeUser.id,
          username: activeUser.username,
          role: activeUser.role.name,
          csrfToken: session.csrfToken,
        },
      };
    },
  });

  fastify.post("/api/auth/logout", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      noStore(reply);
      if (request.sessionUser) {
        await fastify.sessionService.revokeAllForUser(request.sessionUser.id, "logout");
        await fastify.services.audit.record({
          actorId: request.sessionUser.id,
          actorLabel: request.sessionUser.username,
          action: "auth.logout",
          targetType: "session",
          targetId: request.sessionUser.id,
          meta: {},
          ip: request.ip,
        });
      }
      await fastify.sessionService.clearCookie(reply);
      return { ok: true };
    },
  });

  fastify.get("/api/auth/me", async (request, reply) => {
    noStore(reply);
    if (!request.sessionUser) return reply.status(401).send({ error: "authentication required" });
    return {
      user: {
        id: request.sessionUser.id,
        username: request.sessionUser.username,
        role: request.sessionUser.roleName,
      },
      csrfToken: request.sessionUser.csrfToken,
    };
  });

  fastify.post("/api/auth/password", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      noStore(reply);
      const parsed = passwordSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "invalid password", details: parsed.error.issues.map((i) => i.message) });
      }
      const user = await fastify.prisma.adminUser.findUniqueOrThrow({
        where: { id: request.sessionUser!.id },
      });
      if (!(await verifyPassword(user.passwordHash, parsed.data.currentPassword))) {
        return reply.status(401).send({ error: "current password is incorrect" });
      }
      if (parsed.data.currentPassword === parsed.data.newPassword) {
        return reply
          .status(400)
          .send({ error: "new password must differ from the current password" });
      }
      const hash = await hashPassword(parsed.data.newPassword);
      await fastify.prisma.adminUser.update({
        where: { id: user.id },
        data: { passwordHash: hash },
      });
      await fastify.sessionService.revokeAllForUser(user.id, "password changed");
      await fastify.sessionService.clearCookie(reply);
      await fastify.services.audit.record({
        actorId: user.id,
        actorLabel: user.username,
        action: "auth.password_changed",
        targetType: "admin_user",
        targetId: user.id,
        meta: {},
        ip: request.ip,
      });
      return { ok: true };
    },
  });

  fastify.post("/api/auth/users", {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "admin");
      const parsed = createUserSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid user payload",
          details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      const { username, password, role: roleName } = parsed.data;
      const role = await fastify.prisma.role.findUnique({ where: { name: roleName } });
      if (!role)
        return reply.status(500).send({ error: "roles not provisioned; run `pnpm db:seed`" });
      const exists = await fastify.prisma.adminUser.findUnique({ where: { username } });
      if (exists) return reply.status(409).send({ error: "username already exists" });
      const hash = await hashPassword(password);
      const user = await fastify.prisma.adminUser.create({
        data: { username, passwordHash: hash, roleId: role.id },
      });
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "admin_user.create",
        targetType: "admin_user",
        targetId: user.id,
        meta: { username, role: roleName },
        ip: request.ip,
      });
      return reply
        .status(201)
        .send({ user: { id: user.id, username: user.username, role: roleName } });
    },
  });

  fastify.get("/api/auth/users", {
    async handler(request) {
      requireAuth(request);
      requireRole(request, "admin");
      const users = await fastify.prisma.adminUser.findMany({
        where: { deletedAt: null },
        include: { role: true },
        orderBy: { createdAt: "asc" },
      });
      return {
        users: users.map((u) => ({
          id: u.id,
          username: u.username,
          role: u.role.name,
          isActive: u.isActive,
          lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
          createdAt: u.createdAt.toISOString(),
        })),
      };
    },
  });

  fastify.patch("/api/auth/users/:id", {
    async handler(request, reply) {
      requireAuth(request);
      requireCsrf(request);
      requireRole(request, "admin");
      const { id } = request.params as { id: string };
      const parsed = updateUserSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "invalid user payload", details: parsed.error.issues });
      }
      const target = await fastify.prisma.adminUser.findFirst({
        where: { id, deletedAt: null },
        include: { role: true },
      });
      if (!target) return reply.status(404).send({ error: "not found" });
      if (
        target.id === request.sessionUser!.id &&
        (parsed.data.isActive === false || parsed.data.role !== undefined)
      ) {
        return reply
          .status(400)
          .send({ error: "you cannot deactivate or change the role of your own account" });
      }
      const removingAdmin =
        target.role.name === "admin" &&
        ((parsed.data.role !== undefined && parsed.data.role !== "admin") ||
          parsed.data.isActive === false);
      if (removingAdmin) {
        const otherAdmins = await fastify.prisma.adminUser.count({
          where: {
            id: { not: target.id },
            deletedAt: null,
            isActive: true,
            role: { name: "admin" },
          },
        });
        if (otherAdmins === 0) {
          return reply.status(409).send({ error: "cannot remove the last active administrator" });
        }
      }
      let roleId = target.roleId;
      if (parsed.data.role) {
        const role = await fastify.prisma.role.findUnique({ where: { name: parsed.data.role } });
        if (!role) return reply.status(400).send({ error: "unknown role" });
        roleId = role.id;
      }
      const updated = await fastify.prisma.adminUser.update({
        where: { id },
        data: {
          isActive: parsed.data.isActive ?? target.isActive,
          roleId,
        },
        include: { role: true },
      });
      if (parsed.data.isActive === false || parsed.data.role !== undefined) {
        await fastify.sessionService.revokeAllForUser(id, "account privileges changed");
      }
      await fastify.services.audit.record({
        actorId: request.sessionUser!.id,
        actorLabel: request.sessionUser!.username,
        action: "admin_user.update",
        targetType: "admin_user",
        targetId: id,
        meta: { changed: Object.keys(parsed.data) },
        ip: request.ip,
      });
      return {
        user: {
          id: updated.id,
          username: updated.username,
          role: updated.role.name,
          isActive: updated.isActive,
        },
      };
    },
  });
}
