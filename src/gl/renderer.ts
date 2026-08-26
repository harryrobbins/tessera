import { VERT, FRAG } from './shaders';

export interface Camera { x: number; y: number; zoom: number }

export interface RenderStats {
  instances: number;
  drawCalls: number;
  uploadMs: number;
  gpuHint: string;
}

const STYLE_STRIDE = 16; // 4x u16 uv + 4x u8 colour + 4x u8 meta

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

/**
 * One instanced draw call for the whole collection. Per-item state lives in three
 * GPU buffers; a frame costs a handful of uniform writes.
 */
export class CardRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer;
  private fromBuf: WebGLBuffer;
  private toBuf: WebGLBuffer;
  private styleBuf: WebGLBuffer;
  private atlasTex: WebGLTexture;
  private u: Record<string, WebGLUniformLocation | null> = {};

  /** CPU mirrors — kept so a new layout can start from wherever cards are now. */
  from = new Float32Array(0);
  to = new Float32Array(0);
  style = new ArrayBuffer(0);
  private styleU16 = new Uint16Array(0);
  private styleU8 = new Uint8Array(0);

  count = 0;
  capacity = 0;
  /** 0..1 transition progress. */
  t = 1;
  transitionMs = 900;
  stagger = 0.25;
  cornerRadius = 0.14;
  hasAtlas = false;
  lastUploadMs = 0;
  gpuHint = 'unknown';
  /** Rolling GPU time for the card draw, in ms. -1 when unsupported. */
  gpuMs = -1;

  private timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private queries: WebGLQuery[] = [];
  private inFlight: WebGLQuery[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,        // cards are SDF-antialiased in the fragment shader
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      // We deliberately skip frames (idle throttle, GPU pacing). Without this the
      // buffer contents are undefined on any frame we don't draw, and the
      // compositor shows that as a flicker.
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuHint = String(
      (dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER),
    );

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
    }
    this.program = prog;
    for (const name of ['u_t', 'u_cam', 'u_res', 'u_stagger', 'u_atlas', 'u_texEnable', 'u_radius']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.fromBuf = gl.createBuffer()!;
    this.toBuf = gl.createBuffer()!;
    this.styleBuf = gl.createBuffer()!;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.fromBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.toBuf);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(2, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.styleBuf);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_SHORT, true, STYLE_STRIDE, 0);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, STYLE_STRIDE, 8);
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 4, gl.UNSIGNED_BYTE, true, STYLE_STRIDE, 12);
    gl.vertexAttribDivisor(5, 1);

    gl.bindVertexArray(null);

    this.atlasTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // True GPU cost per frame. Without it, a slow driver just queues commands and
    // the rAF rate lies about how fast the frame really was.
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (this.timerExt) {
      for (let i = 0; i < 3; i++) this.queries.push(gl.createQuery()!);
    }

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** (Re)allocate for n cards. Existing contents are discarded. */
  setCount(n: number) {
    const gl = this.gl;
    this.count = n;
    if (n > this.capacity) {
      this.capacity = n;
      this.from = new Float32Array(n * 4);
      this.to = new Float32Array(n * 4);
      this.style = new ArrayBuffer(n * STYLE_STRIDE);
      this.styleU16 = new Uint16Array(this.style);
      this.styleU8 = new Uint8Array(this.style);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fromBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.from.byteLength, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.toBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.to.byteLength, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.styleBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.style.byteLength, gl.DYNAMIC_DRAW);
    }
    this.t = 1;
  }

  /** Per-card appearance. uv rects are 0..1 and are stored as normalised u16. */
  setStyle(i: number, uv: [number, number, number, number], r: number, g: number, b: number, a = 255, delay = 0, selected = 0, dim = 0) {
    const o16 = i * 8;
    this.styleU16[o16] = uv[0] * 65535;
    this.styleU16[o16 + 1] = uv[1] * 65535;
    this.styleU16[o16 + 2] = uv[2] * 65535;
    this.styleU16[o16 + 3] = uv[3] * 65535;
    const o8 = i * STYLE_STRIDE + 8;
    this.styleU8[o8] = r;
    this.styleU8[o8 + 1] = g;
    this.styleU8[o8 + 2] = b;
    this.styleU8[o8 + 3] = a;
    this.styleU8[o8 + 4] = delay * 255;
    this.styleU8[o8 + 5] = selected ? 255 : 0;
    this.styleU8[o8 + 6] = dim * 255;
  }

  setSelected(i: number, on: boolean) {
    this.styleU8[i * STYLE_STRIDE + 8 + 5] = on ? 255 : 0;
  }

  /** Upload a single card's style — used for selection, where re-uploading the
   *  whole buffer would cost 16MB per click at 1M cards. */
  uploadStyleAt(i: number) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.styleBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, i * STYLE_STRIDE, this.styleU8, i * STYLE_STRIDE, STYLE_STRIDE);
  }

  uploadStyle() {
    const gl = this.gl;
    const t0 = performance.now();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.styleBuf);
    // Orphan before writing: bufferSubData over a buffer the GPU may still be
    // reading stalls the CPU until those draws retire (measured at seconds, not
    // milliseconds, at 1M cards). bufferData discards the old store instead.
    gl.bufferData(gl.ARRAY_BUFFER, this.styleU8, gl.DYNAMIC_DRAW, 0, this.count * STYLE_STRIDE);
    this.lastUploadMs = performance.now() - t0;
  }

  /** Snapshot where cards are right now, then aim them at `targets`. Filtered-out
   *  cards (alpha 0) shrink in place rather than flying to the origin. */
  setTargets(targets: Float32Array) {
    const t0 = performance.now();
    const gl = this.gl;
    const n = this.count;
    const from = this.from;
    const to = this.to;
    const e = ease(this.t);

    if (this.t >= 1) {
      from.set(to.subarray(0, n * 4));
    } else {
      for (let k = 0, len = n * 4; k < len; k++) from[k] = from[k] + (to[k] - from[k]) * e;
    }
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (targets[o + 3] === 0) {
        to[o] = from[o];
        to[o + 1] = from[o + 1];
      } else {
        to[o] = targets[o];
        to[o + 1] = targets[o + 1];
      }
      to[o + 2] = targets[o + 2];
      to[o + 3] = targets[o + 3];
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.fromBuf);
    gl.bufferData(gl.ARRAY_BUFFER, from, gl.DYNAMIC_DRAW, 0, n * 4);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.toBuf);
    gl.bufferData(gl.ARRAY_BUFFER, to, gl.DYNAMIC_DRAW, 0, n * 4);
    this.t = 0;
    this.lastUploadMs = performance.now() - t0;
  }

  /** Place cards with no animation (initial load). */
  jumpTo(targets: Float32Array) {
    const n = this.count * 4;
    this.to.set(targets.subarray(0, n));
    this.from.set(targets.subarray(0, n));
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fromBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.from, gl.DYNAMIC_DRAW, 0, n);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.toBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.to, gl.DYNAMIC_DRAW, 0, n);
    this.t = 1;
  }

  /** Drop back to flat colour quads — pixels and dense scatters have no card art. */
  clearAtlas() {
    this.hasAtlas = false;
  }

  setAtlas(source: TexImageSource, mipLevels = 3) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    // Clamp mip levels: slots are padded, but deep mips would still bleed neighbours.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, mipLevels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
    this.hasAtlas = true;
  }

  /** Advance the transition clock. Returns true while still animating. */
  advance(dtMs: number): boolean {
    if (this.t >= 1) return false;
    this.t = Math.min(1, this.t + dtMs / this.transitionMs);
    return true;
  }

  render(cam: Camera, clear: [number, number, number]): RenderStats {
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.count === 0) return { instances: 0, drawCalls: 0, uploadMs: this.lastUploadMs, gpuHint: this.gpuHint };

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform1f(this.u.u_t!, this.t);
    gl.uniform3f(this.u.u_cam!, cam.x, cam.y, cam.zoom);
    gl.uniform2f(this.u.u_res!, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(this.u.u_stagger!, this.stagger);
    gl.uniform1f(this.u.u_texEnable!, this.hasAtlas ? 1 : 0);
    gl.uniform1f(this.u.u_radius!, this.cornerRadius);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.uniform1i(this.u.u_atlas!, 0);

    const q = this.beginTimer();
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    if (q) this.endTimer();
    gl.bindVertexArray(null);
    return { instances: this.count, drawCalls: 1, uploadMs: this.lastUploadMs, gpuHint: this.gpuHint };
  }

  /** True when the GPU is at least two frames behind. Issuing more work now just
   *  grows an invisible queue and makes every wall-clock measurement a lie. */
  gpuBusy(): boolean {
    return this.timerExt !== null && this.inFlight.length >= 2;
  }

  /** Drain finished timer queries. Safe to call every frame, drawn or not. */
  poll() {
    this.pollTimers();
  }

  private beginTimer(): boolean {
    if (!this.timerExt || this.queries.length === 0) return false;
    const q = this.queries.pop()!;
    this.gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q);
    this.inFlight.push(q);
    return true;
  }

  private endTimer() {
    this.gl.endQuery(this.timerExt!.TIME_ELAPSED_EXT);
  }

  /** Never blocks: results are read a frame or two after the fact. */
  private pollTimers() {
    const gl = this.gl;
    const ext = this.timerExt;
    if (!ext || this.inFlight.length === 0) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    const q = this.inFlight[0];
    if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
      this.inFlight.shift();
      if (!disjoint) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
        const ms = ns / 1e6;
        this.gpuMs = this.gpuMs < 0 ? ms : this.gpuMs * 0.8 + ms * 0.2;
      }
      this.queries.push(q);
    }
  }

  /** Current interpolated position of card i (world units) — for hit-testing. */
  positionOf(i: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const e = ease(this.t);
    const o = i * 4;
    out[0] = this.from[o] + (this.to[o] - this.from[o]) * e;
    out[1] = this.from[o + 1] + (this.to[o + 1] - this.from[o + 1]) * e;
    out[2] = this.from[o + 2] + (this.to[o + 2] - this.from[o + 2]) * e;
    return out;
  }

  /** Index of the topmost card containing a world-space point, or -1. */
  pick(wx: number, wy: number): number {
    const e = ease(this.t);
    const { from, to, count } = this;
    for (let i = count - 1; i >= 0; i--) {
      const o = i * 4;
      const s = from[o + 2] + (to[o + 2] - from[o + 2]) * e;
      if (s <= 0) continue;
      const x = from[o] + (to[o] - from[o]) * e;
      const half = s * 0.5;
      if (wx < x - half || wx > x + half) continue;
      const y = from[o + 1] + (to[o + 1] - from[o + 1]) * e;
      if (wy < y - half || wy > y + half) continue;
      return i;
    }
    return -1;
  }

  dispose() {
    const gl = this.gl;
    gl.deleteBuffer(this.quadBuf);
    gl.deleteBuffer(this.fromBuf);
    gl.deleteBuffer(this.toBuf);
    gl.deleteBuffer(this.styleBuf);
    gl.deleteTexture(this.atlasTex);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}

export function ease(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
