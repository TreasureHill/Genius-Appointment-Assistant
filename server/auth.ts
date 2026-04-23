import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";

export type SessionUser = { id: string; email: string };

const COOKIE = "genius_session";
const DAY = 24 * 60 * 60 * 1000;

function getSecret(): string {
  const s = process.env.NEXTAUTH_SECRET || process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error("NEXTAUTH_SECRET (or JWT_SECRET) must be set to a long random string");
  }
  return s;
}

export async function signIn(
  res: Response,
  email: string,
  password: string
): Promise<SessionUser | null> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  const token = jwt.sign({ uid: user.id, email: user.email }, getSecret(), { expiresIn: "7d" });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * DAY,
    path: "/",
  });
  return { id: user.id, email: user.email };
}

export function signOut(res: Response) {
  res.clearCookie(COOKIE, { path: "/" });
}

export function currentUser(req: Request): SessionUser | null {
  const token = (req.cookies ?? {})[COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getSecret()) as { uid: string; email: string };
    return { id: payload.uid, email: payload.email };
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as Request & { user: SessionUser }).user = user;
  next();
}
