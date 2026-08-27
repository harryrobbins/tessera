/**
 * Named marks for the card's header tile. A glyph is a *shape* cue — it says
 * "phone" at 6 px, where the word "Phone" says nothing at all — so both the
 * quiet card and the dense tax-case card draw from the same set, and both fall
 * back to initials for a name they do not recognise.
 *
 * Each path is ≤ 12 segments in a unit box centred on the origin, scaled to
 * ~62 % of the tile.
 */
import { INK } from '../atlas';

/** True when `drawGlyph` has a path for this name. */
export function hasGlyph(name: string): boolean {
  return name === 'Phone' || name === 'Webchat' || name === 'Web form' || name === 'Post';
}

/**
 * Draw the named glyph inside `tile`. Returns false for an unknown name so the
 * caller falls back to initials without having touched the canvas state.
 */
export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  name: string,
  tile: { x: number; y: number; w: number; h: number },
  ink: string,
  stroke: number,
): boolean {
  if (!hasGlyph(name)) return false;
  const s = tile.w * 0.62;
  const cx = tile.x + tile.w / 2;
  const cy = tile.y + tile.h / 2;
  const dark = ink === INK ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.7)';
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.fillStyle = ink;
  ctx.strokeStyle = dark;
  ctx.lineWidth = Math.max(1, stroke) / s;
  switch (name) {
    case 'Phone': {
      ctx.rotate(-Math.PI / 4);
      rrect(ctx, -0.36, -0.09, 0.72, 0.18, 0.09);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(-0.36, 0.02, 0.17, 0, Math.PI * 2);
      ctx.arc(0.36, 0.02, 0.17, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'Webchat': {
      rrect(ctx, -0.5, -0.4, 1.0, 0.68, 0.16);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-0.3, 0.24);
      ctx.lineTo(-0.34, 0.5);
      ctx.lineTo(-0.02, 0.26);
      ctx.closePath();
      ctx.fill();
      // The three dots are 1 px each below this size: texture, not information.
      if (s >= 14) {
        ctx.fillStyle = dark;
        for (const dx of [-0.24, 0, 0.24]) {
          ctx.beginPath();
          ctx.arc(dx, -0.06, 0.07, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case 'Web form': {
      rrect(ctx, -0.36, -0.48, 0.72, 0.96, 0.08);
      ctx.fill();
      if (s >= 14) {
        ctx.lineWidth = 0.09;
        ctx.beginPath();
        for (const dy of [-0.2, 0.0, 0.2]) {
          ctx.moveTo(-0.2, dy);
          ctx.lineTo(dy === 0.2 ? 0.02 : 0.2, dy);
        }
        ctx.stroke();
      }
      break;
    }
    case 'Post': {
      rrect(ctx, -0.5, -0.34, 1.0, 0.68, 0.08);
      ctx.fill();
      ctx.lineWidth = 0.09;
      ctx.beginPath();
      ctx.moveTo(-0.44, -0.28);
      ctx.lineTo(0, 0.06);
      ctx.lineTo(0.44, -0.28);
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
  return true;
}

/** Rounded rectangle as a path; the caller fills or strokes it. */
export function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}
