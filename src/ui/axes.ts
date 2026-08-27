import type { Axis } from '../layout/layouts';
import type { Camera } from '../gl/renderer';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Axis overlay. Ticks live in world space and are projected every frame, so
 * labels stay glued to their bar while the camera moves. Labels that would
 * collide are dropped rather than rotated — an unreadable axis is worse than a
 * sparse one.
 */
export class AxisOverlay {
  private svg: SVGSVGElement;
  xAxis?: Axis;
  yAxis?: Axis;
  private dpr = 1;
  /** What the SVG currently shows; render() is a no-op until one of these moves. */
  private drawn = { x: NaN, y: NaN, zoom: NaN, w: NaN, h: NaN, dpr: NaN, axes: -1 };
  private axesVersion = 0;

  constructor(svg: SVGSVGElement) {
    this.svg = svg;
  }

  set(xAxis?: Axis, yAxis?: Axis) {
    this.xAxis = xAxis;
    this.yAxis = yAxis;
    this.axesVersion++;
    // The x-axis labels run along the bottom of the stage, which is also where
    // the metrics readout sits — and the readout is opaque, so in Bars and
    // Cross-tab it covered the name of the first bucket. Nothing else knows
    // whether there is an axis to make room for, so say so here.
    this.svg.parentElement?.classList.toggle('has-x-axis', Boolean(xAxis));
  }

  /**
   * Called every rAF, drawn only when the camera, viewport or axes changed —
   * an idle frame must not rebuild ~40 SVG nodes.
   */
  render(cam: Camera, cssW: number, cssH: number, dpr: number) {
    const d = this.drawn;
    if (
      d.x === cam.x && d.y === cam.y && d.zoom === cam.zoom &&
      d.w === cssW && d.h === cssH && d.dpr === dpr && d.axes === this.axesVersion
    ) return;
    d.x = cam.x; d.y = cam.y; d.zoom = cam.zoom;
    d.w = cssW; d.h = cssH; d.dpr = dpr; d.axes = this.axesVersion;
    this.dpr = dpr;
    const frag = document.createDocumentFragment();
    if (this.xAxis) this.renderX(frag, this.xAxis, cam, cssW, cssH);
    if (this.yAxis) this.renderY(frag, this.yAxis, cam, cssW, cssH);
    this.svg.replaceChildren(frag);
  }

  private toX(wx: number, cam: Camera, cssW: number) {
    return (wx - cam.x) * (cam.zoom / this.dpr) + cssW / 2;
  }

  private toY(wy: number, cam: Camera, cssH: number) {
    return cssH / 2 - (wy - cam.y) * (cam.zoom / this.dpr);
  }

  private renderX(frag: DocumentFragment, axis: Axis, cam: Camera, cssW: number, cssH: number) {
    const y = cssH - 38;
    frag.appendChild(line(0, y, cssW, y));
    let lastRight = -Infinity;
    for (const t of axis.ticks) {
      // A filtered-out bucket draws no bar; labelling the gap just adds noise.
      if (t.count === 0) continue;
      const x = this.toX(t.pos, cam, cssW);
      if (x < -80 || x > cssW + 80) continue;
      const label = t.count !== undefined ? `${t.label}  ·  ${fmtCount(t.count)}` : t.label;
      // Cheap width estimate for the collision test, in step with the
      // .axes text rule in style.css: 12.5px at weight 600.
      const width = label.length * 7.2;
      if (x - width / 2 < lastRight + 10) continue;
      lastRight = x + width / 2;
      frag.appendChild(text(x, y + 14, label, 'middle'));
      frag.appendChild(line(x, y - 5, x, y));
    }
    frag.appendChild(text(cssW / 2, cssH - 8, axis.title, 'middle', 'title'));
  }

  private renderY(frag: DocumentFragment, axis: Axis, cam: Camera, cssW: number, cssH: number) {
    const x = 54;
    frag.appendChild(line(x, 0, x, cssH - 38));
    let lastBottom = Infinity;
    for (const t of axis.ticks) {
      const y = this.toY(t.pos, cam, cssH);
      if (y < -20 || y > cssH + 20) continue;
      if (y > lastBottom - 18) continue;
      lastBottom = y;
      frag.appendChild(text(x - 8, y + 4, t.label, 'end'));
      frag.appendChild(line(x, y, x + 5, y));
    }
    const title = text(0, 0, axis.title, 'middle', 'title');
    title.setAttribute('transform', `translate(14, ${cssH / 2}) rotate(-90)`);
    frag.appendChild(title);
  }
}

function line(x1: number, y1: number, x2: number, y2: number) {
  const el = document.createElementNS(SVG_NS, 'line');
  el.setAttribute('x1', String(x1));
  el.setAttribute('y1', String(y1));
  el.setAttribute('x2', String(x2));
  el.setAttribute('y2', String(y2));
  return el;
}

function text(x: number, y: number, s: string, anchor: string, cls?: string) {
  const el = document.createElementNS(SVG_NS, 'text');
  el.setAttribute('x', String(x));
  el.setAttribute('y', String(y));
  el.setAttribute('text-anchor', anchor);
  if (cls) el.setAttribute('class', cls);
  el.textContent = s;
  return el;
}

function fmtCount(n: number) {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
}
