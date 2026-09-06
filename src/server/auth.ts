/**
 * Authentication. Deliberately the smallest thing that works.
 *
 * WHY IT EXISTS AT ALL
 * The brief asks how state persists "across sessions/devices". localStorage
 * answers the first half and fails the second: your baseline on the laptop
 * would not be your baseline on the phone, and "since you last checked"
 * would mean something different on each screen. So identity has to be
 * server-side, and identity means accounts.
 *
 * WHAT WE DELIBERATELY DID NOT BUILD
 * OAuth, email verification, password reset, refresh-token rotation. Each
 * is a half-day and none of them is what this project is being judged on.
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "./prisma.ts";

const SECRET = process.env.JWT_SECRET ?? "dev-only-change-me";
const TOKEN_TTL = "30d"; // long, because re-login would reset nothing but annoy

export type AuthedRequest = Request & { userId?: string };

export async function register(email: string, password: string) {
  if (!email.includes("@")) throw new Error("Enter a valid email address");
  if (password.length < 8) throw new Error("Use at least 8 characters");

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new Error("That email is already registered");

  const user = await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash(password, 10) },
  });
  return { token: sign(user.id), email: user.email };
}

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  // Same message either way, so the endpoint cannot be used to enumerate
  // which email addresses have accounts.
  const bad = new Error("Email or password is incorrect");
  if (!user) throw bad;
  if (!(await bcrypt.compare(password, user.passwordHash))) throw bad;

  return { token: sign(user.id), email: user.email };
}

function sign(userId: string): string {
  return jwt.sign({ sub: userId }, SECRET, { expiresIn: TOKEN_TTL });
}

/** Express middleware. Rejects anything without a valid bearer token. */
export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sign in to continue" });

  try {
    const payload = jwt.verify(token, SECRET) as { sub: string };
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "Your session expired. Sign in again." });
  }
}
