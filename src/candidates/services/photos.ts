import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { ApiError } from "../lib/errors";

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const photoIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/);
export const photoUploadSchema = z.object({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  dataBase64: z.string().min(4).max(Math.ceil(MAX_PHOTO_BYTES / 3) * 4),
}).strict();
export type PhotoUpload = z.infer<typeof photoUploadSchema>;
export type StoredPhoto = { bytes: Uint8Array; contentType: string };
const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;

export function decodePhoto(input: PhotoUpload) {
  const bytes = Buffer.from(input.dataBase64, "base64");
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES || bytes.toString("base64") !== input.dataBase64) {
    throw new ApiError(400, "INVALID_PHOTO", "Choose a JPEG, PNG, or WebP image no larger than 2 MB after resizing.");
  }
  const valid = input.contentType === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    : input.contentType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid) throw new ApiError(400, "INVALID_PHOTO", "The file contents do not match a supported image format.");
  return bytes;
}

export class CandidatePhotoStore {
  constructor(private readonly bucket: string, private readonly client = new S3Client({})) {}
  async create(input: PhotoUpload): Promise<string> {
    const body = decodePhoto(input);
    if (!this.bucket) throw new ApiError(503, "PHOTOS_UNAVAILABLE", "Photo uploads are temporarily unavailable.");
    const photoId = `${randomUUID()}.${extensions[input.contentType]}`;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: `photos/${photoId}`, Body: body, ContentType: input.contentType, CacheControl: "public,max-age=31536000,immutable" }));
    return photoId;
  }
  async get(photoId: string): Promise<StoredPhoto> {
    if (!this.bucket) throw new ApiError(503, "PHOTOS_UNAVAILABLE", "Profile photos are temporarily unavailable.");
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: `photos/${photoId}` }));
      if (!result.Body) throw new ApiError(404, "PHOTO_NOT_FOUND", "Photo not found.");
      const extension = photoId.split(".").pop();
      return { bytes: await result.Body.transformToByteArray(), contentType: extension === "jpg" ? "image/jpeg" : `image/${extension}` };
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchKey") throw new ApiError(404, "PHOTO_NOT_FOUND", "Photo not found.");
      throw error;
    }
  }
}
