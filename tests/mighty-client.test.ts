import { beforeEach, expect, it, vi } from "vitest";
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("axios", () => ({ default: { create: () => ({ get }) } }));
vi.mock("../src/config", () => ({ config: {} }));
import { MightyClient } from "../src/lib/mightyClient";
beforeEach(() => vi.resetAllMocks());

it("limits event-detail concurrency, preserves order and retains upstream pagination", async () => {
  let active = 0;
  let peak = 0;
  get.mockImplementation(async (url: string) => {
    if (url.endsWith("/posts")) return { data: { items: [
      { id: 99, post_type: "post" },
      ...Array.from({ length: 12 }, (_, id) => ({ id, post_type: "event" })),
    ], links: { next: "?page=2" } } };
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return { data: { id: Number(url.split("/").at(-1)), starts_at: "2026-11-09T09:00:00-06:00" } };
  });
  const response = await new MightyClient("fixture", "example").getSpaceEvents("123", { perPage: 100, page: 2 });
  expect(peak).toBe(3);
  expect(response.items.map((item: { id: number }) => item.id)).toEqual(Array.from({ length: 12 }, (_, id) => id));
  expect(response.links.next).toBe("?page=2");
  expect(get).toHaveBeenCalledWith("/networks/example/posts", { params: { space_id: "123", page: 2, per_page: 100 } });
});

it("stops queued detail calls and surfaces an upstream failure instead of undated stubs", async () => {
  const failure = new Error("Rate limited");
  get.mockImplementation(async (url: string) => {
    if (url.endsWith("/posts")) return { data: { items: Array.from({ length: 12 }, (_, id) => ({ id, post_type: "event" })) } };
    throw failure;
  });
  await expect(new MightyClient("fixture", "example").getSpaceEvents("123")).rejects.toBe(failure);
  expect(get.mock.calls.filter(([url]) => String(url).includes("/events/"))).toHaveLength(3);
});
