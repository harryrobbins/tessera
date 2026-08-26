/** Instanced card shaders. All motion happens on the GPU: the CPU uploads
 *  `from` and `to` once per layout change, then only a single float changes per
 *  frame (u_t). */
export const VERT = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_corner;   // unit quad, -0.5..0.5
layout(location = 1) in vec4 a_from;     // x, y, size, alpha
layout(location = 2) in vec4 a_to;
layout(location = 3) in vec4 a_uv;       // atlas rect u0, v0, u1, v1 (normalised u16)
layout(location = 4) in vec4 a_color;    // tint / far-zoom colour
layout(location = 5) in vec4 a_meta;     // x: stagger delay, y: selected, z: dim, w: -

uniform float u_t;        // 0..1 transition progress
uniform vec3 u_cam;       // world x, world y, device px per world unit
uniform vec2 u_res;       // drawing buffer size, device px
uniform float u_stagger;  // 0 = all cards move together, 0.4 = pronounced wave

out vec2 v_local;
out vec2 v_uv;
out vec4 v_color;
out float v_px;
out float v_sel;

float easeInOutCubic(float x) {
  return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) * 0.5;
}

void main() {
  float delay = a_meta.x * u_stagger;
  float t = easeInOutCubic(clamp((u_t - delay) / max(1e-4, 1.0 - delay), 0.0, 1.0));
  vec4 s = mix(a_from, a_to, t);

  vec2 world = s.xy + a_corner * s.z;
  vec2 screen = (world - u_cam.xy) * u_cam.z;
  gl_Position = vec4(screen / (u_res * 0.5), 0.0, 1.0);

  v_local = a_corner;
  v_uv = vec2(
    mix(a_uv.x, a_uv.z, a_corner.x + 0.5),
    mix(a_uv.w, a_uv.y, a_corner.y + 0.5)   // world +y is the top of the card
  );
  v_color = vec4(a_color.rgb, a_color.a * s.w * (1.0 - a_meta.z * 0.72));
  v_px = s.z * u_cam.z;
  v_sel = a_meta.y;
}
`;

export const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 v_local;
in vec2 v_uv;
in vec4 v_color;
in float v_px;
in float v_sel;

uniform sampler2D u_atlas;
uniform float u_texEnable;   // 0 disables atlas sampling entirely
uniform float u_radius;      // corner radius as a fraction of the card

out vec4 outColor;

void main() {
  float r = u_radius;
  vec2 q = abs(v_local) - (0.5 - r);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;

  // One-pixel feather regardless of zoom; tiny cards stay legible dots.
  float aa = max(fwidth(d), 1.0 / max(v_px, 1.0));
  float mask = 1.0 - smoothstep(-aa, aa, d);
  if (mask <= 0.002) discard;

  vec3 rgb = v_color.rgb;
  // Texture fades in as cards grow past a few pixels — automatic LOD, no popping.
  float texMix = u_texEnable * smoothstep(3.0, 9.0, v_px);
  if (texMix > 0.0) {
    vec4 tex = texture(u_atlas, v_uv);
    rgb = mix(rgb, tex.rgb, texMix * tex.a);
  }

  // Soft top-down sheen, then a rim light on the card edge: reads as a physical tile.
  rgb *= 1.0 + 0.06 * v_local.y;
  float rim = smoothstep(-aa * 2.0, -aa, d) * (1.0 - smoothstep(-aa * 5.0, -aa * 2.0, d));
  rgb += rim * 0.18 * smoothstep(6.0, 18.0, v_px);

  if (v_sel > 0.5) {
    float ring = 1.0 - smoothstep(0.0, aa * 3.0, abs(d + aa * 2.0));
    rgb = mix(rgb, vec3(1.0), ring * 0.85);
  }

  outColor = vec4(rgb, v_color.a * mask);
}
`;
