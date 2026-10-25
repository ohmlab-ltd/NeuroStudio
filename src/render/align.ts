// Thermal-to-camera auto-registration: the scale and offset that best correlate the gradient
// magnitudes of the thermal frame and the camera image.

import type { ThermalFrame } from "../device/tlv";
import { overlayOptions, setThermalAlignment } from "../state/options";

const CAM_WIDTH = 96;
const THERM_W = 40;
const THERM_H = 30;

function gradient(l: Float32Array, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = l[i + 1] - l[i - 1];
      const gy = l[i + w] - l[i - w];
      g[i] = Math.abs(gx) + Math.abs(gy);
    }
  }
  return g;
}

function blur3(g: Float32Array, w: number, h: number): Float32Array {
  const o = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      o[i] =
        (g[i] * 4 +
          (g[i - 1] + g[i + 1] + g[i - w] + g[i + w]) * 2 +
          g[i - w - 1] +
          g[i - w + 1] +
          g[i + w - 1] +
          g[i + w + 1]) /
        16;
    }
  }
  return o;
}

export class ThermalAligner {
  private busy = false;
  private locked = false;
  private missStreak = 0;
  private lastScale = -1;
  private lastX = 9;
  private lastY = 9;
  private canvas: HTMLCanvasElement | null = null;

  /** Forgets the lock, so AUTO starts again with a wide search. */
  reset(): void {
    this.locked = false;
    this.missStreak = 0;
  }

  run(camera: ImageBitmap | null, thermal: ThermalFrame | null): void {
    const options = overlayOptions.get();
    if (!options.thermalOverlayAuto) {
      this.reset();
      return;
    }
    if (this.busy || options.thermalOverlayOpacity <= 0 || !camera || !thermal) return;
    if (thermal.width < 3 || thermal.height < 3) return;

    this.busy = true;
    try {
      this.align(camera, thermal);
    } catch {
      // Best-effort: alignment is cosmetic.
    } finally {
      this.busy = false;
    }
  }

  private align(camera: ImageBitmap, thermal: ThermalFrame): void {
    const cw = CAM_WIDTH;
    const ch = Math.max(3, Math.round((camera.height / camera.width) * CAM_WIDTH));
    if (!this.canvas) this.canvas = document.createElement("canvas");
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(camera, 0, 0, cw, ch);
    const pixels = ctx.getImageData(0, 0, cw, ch).data;

    const cl = new Float32Array(cw * ch);
    for (let i = 0, p = 0; i < cl.length; i++, p += 4) {
      cl[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
    }
    const cg = blur3(gradient(cl, cw, ch), cw, ch);

    // The stride comes from the frame's own size, so any thermal resolution works.
    const sxStep = thermal.width / THERM_W;
    const syStep = thermal.height / THERM_H;
    const tl = new Float32Array(THERM_W * THERM_H);
    for (let y = 0; y < THERM_H; y++) {
      const py = Math.min(thermal.height - 1, Math.floor(y * syStep));
      for (let x = 0; x < THERM_W; x++) {
        const px = Math.min(thermal.width - 1, Math.floor(x * sxStep));
        tl[y * THERM_W + x] = thermal.pixels[py * thermal.width + px];
      }
    }
    const tg = blur3(gradient(tl, THERM_W, THERM_H), THERM_W, THERM_H);

    const camAspect = cw / ch;

    const nccAt = (sc: number, ox: number, oy: number): number => {
      const hFrac = sc * 0.75 * camAspect;
      let sa = 0;
      let sb = 0;
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      let n = 0;
      for (let ty = 1; ty < THERM_H - 1; ty++) {
        for (let tx = 1; tx < THERM_W - 1; tx++) {
          const u = 0.5 + ox + (tx / THERM_W - 0.5) * sc;
          const v = 0.5 + oy + (ty / THERM_H - 0.5) * hFrac;
          if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
          const a = tg[ty * THERM_W + tx];
          const b = cg[Math.floor(v * ch) * cw + Math.floor(u * cw)];
          sa += a;
          sb += b;
          sab += a * b;
          saa += a * a;
          sbb += b * b;
          n++;
        }
      }
      if (n < 200) return -1;
      const cov = sab - (sa * sb) / n;
      const va = saa - (sa * sa) / n;
      const vb = sbb - (sb * sb) / n;
      if (va <= 0 || vb <= 0) return -1;
      return cov / Math.sqrt(va * vb);
    };

    let best = -1;
    let bs = 0.9;
    let bx = 0;
    let by = 0;

    const refine = (cs: number, cx: number, cy: number) => {
      for (let sc = cs - 0.08; sc <= cs + 0.08; sc += 0.027) {
        for (let ox = cx - 0.045; ox <= cx + 0.045; ox += 0.015) {
          for (let oy = cy - 0.045; oy <= cy + 0.045; oy += 0.015) {
            const v = nccAt(sc, ox, oy);
            if (v > best) {
              best = v;
              bs = sc;
              bx = ox;
              by = oy;
            }
          }
        }
      }
    };

    const options = overlayOptions.get();
    if (this.locked) {
      // Locked: a narrow search around the live alignment.
      refine(
        options.thermalOverlayScale,
        options.thermalOverlayOffsetX,
        options.thermalOverlayOffsetY,
      );
    } else {
      // Hunting: a coarse grid, then a refine around the best.
      for (let sc = 0.5; sc <= 1.35; sc += 0.1) {
        for (let ox = -0.22; ox <= 0.22; ox += 0.055) {
          for (let oy = -0.22; oy <= 0.22; oy += 0.055) {
            const v = nccAt(sc, ox, oy);
            if (v > best) {
              best = v;
              bs = sc;
              bx = ox;
              by = oy;
            }
          }
        }
      }
      refine(bs, bx, by);
    }

    if (!overlayOptions.get().thermalOverlayAuto) return;

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    // Steers only once two consecutive measurements agree.
    if (best > 0.22) {
      this.missStreak = 0;
      const agree =
        Math.abs(this.lastScale - bs) < 0.12 &&
        Math.abs(this.lastX - bx) < 0.06 &&
        Math.abs(this.lastY - by) < 0.06;
      this.lastScale = bs;
      this.lastX = bx;
      this.lastY = by;
      if (agree) {
        const live = overlayOptions.get();
        if (!this.locked) {
          this.locked = true;
          setThermalAlignment(bs, bx, by);
        } else {
          setThermalAlignment(
            lerp(live.thermalOverlayScale, bs, 0.5),
            lerp(live.thermalOverlayOffsetX, bx, 0.5),
            lerp(live.thermalOverlayOffsetY, by, 0.5),
          );
        }
      }
    } else if (this.locked && ++this.missStreak >= 5) {
      // Five misses while locked: hold position and return to the wide search.
      this.locked = false;
      this.missStreak = 0;
    }
  }
}
