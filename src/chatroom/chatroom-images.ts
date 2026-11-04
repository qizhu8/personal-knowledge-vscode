export const MAX_CHATROOM_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CHATROOM_IMAGES = 4;

export function chatroomImageMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export function decodeChatroomImages(value: unknown): { name: string; mime: string; data: Buffer }[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_CHATROOM_IMAGES) {
    throw new Error(`Attach between one and ${MAX_CHATROOM_IMAGES} images.`);
  }
  return value.map((image: unknown, index) => {
    if (!image || typeof image !== "object") throw new Error("Invalid clipboard image.");
    const { mime, dataBase64 } = image as Record<string, unknown>;
    if (typeof dataBase64 !== "string" || !dataBase64.length || dataBase64.length % 4 !== 0 || dataBase64.length > 4 * Math.ceil(MAX_CHATROOM_IMAGE_BYTES / 3)
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
      throw new Error("Clipboard images must be valid base64 and at most 5 MB each.");
    }
    const data = Buffer.from(dataBase64, "base64");
    const detected = chatroomImageMime(data);
    if (!detected || detected !== mime || data.length > MAX_CHATROOM_IMAGE_BYTES) {
      throw new Error("Paste a PNG, JPEG, GIF or WebP image, at most 5 MB each.");
    }
    const extension = detected.split("/")[1].replace("jpeg", "jpg");
    return { name:`pasted-image-${index + 1}.${extension}`, mime:detected, data };
  });
}
