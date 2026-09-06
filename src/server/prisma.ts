import { PrismaClient } from "@prisma/client";

/**
 * One client, reused. Creating a PrismaClient per request exhausts the
 * connection pool within a minute or two under any real load.
 */
export const prisma = new PrismaClient();

/**
 * THE DEMO CLOCK.
 *
 * The product's entire premise is "come back later and see what changed",
 * which is impossible to show in a five-minute review if you have to wait
 * for real time to pass. So the server has one injectable clock and every
 * timestamp in the read path goes through it.
 *
 * Guarded by DEMO_MODE so it cannot be poked in a real deployment.
 */
let offsetMs = 0;

export function now(): Date {
  return new Date(Date.now() + offsetMs);
}

export function nowISO(): string {
  return now().toISOString();
}

export function demoEnabled(): boolean {
  return process.env.DEMO_MODE === "true";
}

export function advanceClock(minutes: number): number {
  if (!demoEnabled()) throw new Error("demo clock is disabled");
  offsetMs += minutes * 60_000;
  return offsetMs;
}

export function resetClock(): void {
  offsetMs = 0;
}

export function clockOffsetMinutes(): number {
  return Math.round(offsetMs / 60_000);
}
