/** Instanced card shaders. All motion happens on the GPU: the CPU uploads
 *  `from` and `to` once per layout change, then only a single float changes per
 *  frame (u_t). */
/** Smallest on-screen spread of a night-lights halo, in device pixels: enough
 *  that a sub-pixel dot cannot fall out of the raster, little enough that a
 *  town reads as a cluster of points rather than a smear. */
export const GLOW_FLOOR_PX = 2.5;

export const VERT = /* glsl */ `#version 300 es
precision highp float;

const float GLOW_FLOOR_PX = ${GLOW_FLOOR_PX.toFixed(1)};

layout(location = 0) in vec2 a_corner;   // unit quad, -0.5..0.5
layout(location = 1) in vec4 a_from;     // x, y, size, alpha
layout(location = 2) in vec4 a_to;
layout(location = 3) in vec4 a_uv;       // atlas rect u0, v0, u1, v1 (normalised u16)
layout(location = 4) in vec4 a_color;    // tint / far-zoom colour
layout(location = 5) in vec4 a_meta;     // x: stagger delay, y: selected, z: spare, w: 1 = sample the hi-res atlas

uniform float u_t;        // 0..1 transition progress
uniform vec3 u_cam;       // world x, world y, device px per world unit
uniform vec2 u_res;       // drawing buffer size, device px
uniform float u_stagger;  // 0 = all cards move together, 0.4 = pronounced wave
uniform vec2 u_lod;       // card width (device px) over which flat dot fades into card art
uniform float u_glow;     // 1 = below the LOD band, cards are additive points of light (map)

out vec2 v_local;
out float v_halo;
out vec2 v_uv;
out vec4 v_color;
out float v_px;
out float v_sel;
out float v_hi;

float easeInOutCubic(float x) {
  return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) * 0.5;
}

void main() {
  float delay = a_meta.x * u_stagger;
  float t = easeInOutCubic(clamp((u_t - delay) / max(1e-4, 1.0 - delay), 0.0, 1.0));
  vec4 s = mix(a_from, a_to, t);

  // Night lights: under the LOD band the quad grows into a halo (3x the card,
  // and never smaller than GLOW_FLOOR_PX on screen, so a sub-pixel dot cannot
  // drop out of the raster) and neighbouring lights overlap and add. The card
  // itself is still drawn at its own size inside it (see v_halo in the
  // fragment shader).
  //
  // The floor is deliberately small. At 6 px every card's halo was pinned to
  // 6 px however far out you zoomed — 12x the card at half a pixel, 30x at a
  // fifth — so zooming out never resolved the map into points, it just packed
  // more 6 px blobs into the same area until they washed together.
  float px = s.z * u_cam.z;
  // u_glow is a uniform, so this branch is taken by the whole draw call or by
  // none of it: off the map the smoothstep and the divide never run.
  float halo = 1.0;
  if (u_glow > 0.0) {
    float light = u_glow * (1.0 - smoothstep(u_lod.x, u_lod.y, px));
    halo = 1.0 + light * (max(3.0, GLOW_FLOOR_PX / max(px, 1e-3)) - 1.0);
  }
  vec2 world = s.xy + a_corner * s.z * halo;
  vec2 screen = (world - u_cam.xy) * u_cam.z;
  gl_Position = vec4(screen / (u_res * 0.5), 0.0, 1.0);

  v_local = a_corner;
  v_halo = halo;
  v_uv = vec2(
    mix(a_uv.x, a_uv.z, a_corner.x + 0.5),
    mix(a_uv.w, a_uv.y, a_corner.y + 0.5)   // world +y is the top of the card
  );
  v_color = vec4(a_color.rgb, a_color.a * s.w);
  v_px = px;
  v_sel = a_meta.y;
  v_hi = a_meta.w;
}
`;

export const FRAG = /* glsl */ `#version 300 es
precision highp float;

const float GLOW_PEAK = 1.5;   // exp(-6r^2) vs exp(-4r^2): 6/4
precision highp sampler2D;

in vec2 v_local;
in float v_halo;
in vec2 v_uv;
in vec4 v_color;
in float v_px;
in float v_sel;
in float v_hi;

uniform sampler2D u_atlas;
uniform sampler2D u_hi;      // hi-res re-rasterisations of the cards in view when magnified
uniform float u_hasHi;       // 0 while no card is flipped to u_hi — then it is never fetched
uniform float u_texEnable;   // 0 disables atlas sampling entirely
uniform float u_radius;      // corner radius as a fraction of the card
uniform float u_edgeAA;      // 1 = feathered edges, 0 = hard (for tiling quads)
uniform vec2 u_lod;          // card width (device px) over which flat dot fades into card art
uniform float u_glow;        // 1 = below the LOD band, cards are additive points of light (map)

out vec4 outColor;

void main() {
  // Tiling quads are square: a corner radius on a card that covers one device
  // pixel puts every pixel centre exactly on the rounded corner, where the SDF
  // reads "outside" and the whole collection discards itself.
  float r = u_radius * u_edgeAA;
  // Card-local coordinates: the quad may be a halo larger than the card.
  vec2 lc = v_local * v_halo;
  vec2 q = abs(lc) - (0.5 - r);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;

  // One-pixel feather regardless of zoom; tiny cards stay legible dots.
  // Cards that tile edge to edge must NOT be feathered: two abutting half-covered
  // edges composite to less than full coverage, and that seam beats against the
  // display grid as moire. Collapsing the feather makes the seam exact instead.
  float aa = max(fwidth(d), 1.0 / max(v_px, 1.0)) * u_edgeAA + 1e-6;
  // With hard edges the rasteriser's own coverage is the answer — every fragment
  // it hands us belongs to exactly one quad, so never mask and never discard.
  float mask = mix(1.0, 1.0 - smoothstep(-aa, aa, d), u_edgeAA);

  // Texture fades in as cards grow past a few pixels — automatic LOD, no popping.
  float texMix = u_texEnable * smoothstep(u_lod.x, u_lod.y, v_px);
  // Night lights: under the LOD band each card is a soft warm-cored glow that
  // accumulates where cards crowd — a city sums towards white, a lone card
  // stays a dim coloured point. Colour-by still tints the light.
  //
  // Uniform branch again: every layout but the map skips the exponential and
  // the reciprocal below, which is the most expensive arithmetic in the shader
  // and was being paid on every fragment of every collection.
  float light = 0.0;
  float core = 0.0;
  if (u_glow > 0.0) {
    light = u_glow * (1.0 - texMix);
    float r2 = dot(v_local, v_local) * 4.0;             // 0 centre .. 1 edge of the halo
    // Energy conservation: the quad's area grows with halo^2, so the amplitude
    // has to fall with it or every card emits *more* total light the further out
    // you zoom — which is why the far view used to bloom instead of resolving.
    //
    // Normalised to the minimum halo (3x) and scaled by GLOW_PEAK, because
    // exp(-6r^2) integrates to two thirds of exp(-4r^2): together those keep a
    // card at the minimum halo emitting exactly what it did before, so only the
    // zoomed-out view changes.
    core = exp(-r2 * 6.0) * min(GLOW_PEAK, GLOW_PEAK * 9.0 / (v_halo * v_halo));
  }
  float glow = light * core;
  if (mask <= 0.002 && glow <= 0.002) discard;

  vec3 rgb = v_color.rgb;
  if (texMix > 0.0) {
    // v_hi varies between neighbouring instances, so the two fetches stay
    // unconditional within a draw: branching on it would leave the mip
    // derivatives undefined at the seam between hi-res and base cards. u_hasHi
    // is uniform and settles the whole draw call, and it is 0 for every frame
    // with no plan committed — which is most of them, and all of them above
    // the zoom where a card is worth its own raster.
    vec4 tex = texture(u_atlas, v_uv);
    if (u_hasHi > 0.0) tex = mix(tex, texture(u_hi, v_uv), v_hi);
    rgb = mix(rgb, tex.rgb, texMix * tex.a);
  }

  // Soft top-down sheen, then a rim light on the card edge: reads as a physical tile.
  rgb *= 1.0 + 0.06 * lc.y;
  float rim = smoothstep(-aa * 2.0, -aa, d) * (1.0 - smoothstep(-aa * 5.0, -aa * 2.0, d));
  rgb += rim * 0.18 * smoothstep(u_lod.x * 2.0, u_lod.y * 2.0, v_px);

  // 1.0 = selected (a white ring), 0.5 = hovered or keyboard-focused (a
  // quieter one, so the two are never confused for each other).
  if (v_sel > 0.25) {
    float ring = 1.0 - smoothstep(0.0, aa * 3.0, abs(d + aa * 2.0));
    rgb = mix(rgb, vec3(1.0), ring * (v_sel > 0.75 ? 0.85 : 0.4));
  }

  // Premultiplied output (blend ONE, ONE_MINUS_SRC_ALPHA): identical to the old
  // straight-alpha path for cards, and it lets the same draw call emit
  // alpha-0 fragments that simply add to whatever is beneath them.
  float a = v_color.a * mask;
  vec4 card = vec4(rgb * a, a);

  outColor = card;
  if (u_glow > 0.0) {
    vec3 warm = vec3(1.0, 0.86, 0.62);
    vec3 lit = mix(v_color.rgb, warm, 0.45 * core) * core;
    vec4 add = vec4(lit * v_color.a, 0.0);
    outColor = mix(card, add, light);
  }
}
`;
