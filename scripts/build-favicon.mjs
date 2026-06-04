import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const input = resolve(root, "public/compass-logo-mark.png");
const out256 = resolve(root, "public/compass-icon.png");
const out32 = resolve(root, "public/compass-icon-32.png");

// Detect the actual bounding box of non-transparent pixels (trim whitespace),
// then crop to a square padded a bit around the needle and resize.
async function build() {
  // sharp.trim removes uniform/transparent borders.
  const trimmed = sharp(input).trim();
  const meta = await trimmed.toBuffer({ resolveWithObject: true });

  const w = meta.info.width;
  const h = meta.info.height;

  // The trimmed image still contains the wordmark below the needle.
  // The needle occupies roughly the top ~60% of the trimmed bounding box.
  // Crop the upper square portion to isolate the needle.
  const side = Math.min(w, Math.round(h * 0.62));
  const left = Math.max(0, Math.round((w - side) / 2));
  const top = 0;

  const square = await sharp(meta.data)
    .extract({ left, top, width: side, height: side })
    .toBuffer();

  await sharp(square)
    .resize(256, 256, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(out256);

  await sharp(square)
    .resize(32, 32, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(out32);

  console.log("favicon built:", { w, h, side, left, top, out256, out32 });
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
