import { AppError } from "../shared/types.js";

// Reservations are synchronous, including while context creation is pending.
export class CapacityGate {
  private used = 0;
  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1)
      throw new Error("Capacity must be a positive integer");
  }
  get inUse() { return this.used; }
  acquire() {
    if (this.used >= this.maximum)
      throw new AppError("BROWSER_BUSY", "浏览器正在处理其他操作，请稍后重试", 503, true);
    this.used++;
    let released = false;
    return () => {
      if (!released) { released = true; this.used--; }
    };
  }
}

export async function boundedContext<T extends { on(event: "close", listener: () => void): unknown }>(
  gate: CapacityGate,
  create: () => Promise<T>,
): Promise<T> {
  const release = gate.acquire();
  try {
    const context = await create();
    context.on("close", release);
    return context;
  } catch (error) {
    release();
    throw error;
  }
}
