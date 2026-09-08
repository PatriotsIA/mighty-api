import { expect, it, vi } from "vitest";
import { CandidatePhotoStore, decodePhoto, MAX_PHOTO_BYTES, photoIdSchema } from "../src/candidates/services/photos";
import type { S3Client } from "@aws-sdk/client-s3";

const png = { contentType: "image/png" as const, dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=" };
it("validates image type and size before private storage and serves stable image bytes", async () => {
  const send = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ Body: { transformToByteArray: async () => Buffer.from(png.dataBase64, "base64") } });
  const store = new CandidatePhotoStore("private-photo-bucket", { send } as unknown as S3Client);
  await expect(store.create({ ...png, contentType: "image/jpeg" })).rejects.toThrow("format");
  expect(send).not.toHaveBeenCalled();
  const id = await store.create(png);
  expect(photoIdSchema.safeParse(id).success).toBe(true);
  expect(send.mock.calls[0]![0].input).toMatchObject({ Bucket: "private-photo-bucket", Key: `photos/${id}`, ContentType: "image/png" });
  expect(send.mock.calls[0]![0].input).not.toHaveProperty("ACL");
  expect(await store.get(id)).toEqual({ bytes: Buffer.from(png.dataBase64, "base64"), contentType: "image/png" });
  expect(() => decodePhoto({ ...png, dataBase64: Buffer.alloc(MAX_PHOTO_BYTES + 1).toString("base64") })).toThrow("2 MB");
  expect(() => decodePhoto({ ...png, dataBase64: Buffer.from("<svg onload='alert(1)'/>").toString("base64") })).toThrow("format");
  expect(() => decodePhoto({ ...png, dataBase64: png.dataBase64 + "\n" })).toThrow();
  expect(photoIdSchema.safeParse("../private.txt").success).toBe(false);
});
