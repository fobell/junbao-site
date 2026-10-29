import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { CapacityGate, boundedContext } from "../src/browser/capacity.js";

describe("browser capacity", () => {
  it("counts in-flight creation before await and frees a failed reservation", async () => {
    const gate = new CapacityGate(1);
    let reject!: (error: Error) => void;
    const pending = boundedContext(gate, () => new Promise<EventEmitter>((_resolve, fail) => { reject = fail; }));
    await expect(boundedContext(gate, async () => new EventEmitter())).rejects.toMatchObject({ code: "BROWSER_BUSY", retryable: true });
    reject(new Error("launch failed"));
    await expect(pending).rejects.toThrow("launch failed");
    expect(gate.inUse).toBe(0);
    const recovered = await boundedContext(gate, async () => new EventEmitter());
    recovered.emit("close");
    expect(gate.inUse).toBe(0);
  });
  it("releases closed, expired or cancelled contexts exactly once", async () => {
    const gate = new CapacityGate(2);
    const a = await boundedContext(gate, async () => new EventEmitter());
    const b = await boundedContext(gate, async () => new EventEmitter());
    expect(() => gate.acquire()).toThrow();
    a.emit("close"); a.emit("close");
    expect(gate.inUse).toBe(1);
    const release = gate.acquire();
    b.emit("close"); release(); release();
    expect(gate.inUse).toBe(0);
  });
  it("rejects invalid capacity", () => {
    for (const value of [0, -1, 1.5, NaN, Infinity]) expect(() => new CapacityGate(value)).toThrow();
  });
});
