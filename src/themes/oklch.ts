import { ColorRgba } from "rich-js";

// --- sRGB ↔ linear sRGB ---

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// --- CSS Color Level 4 matrices for OKLab ---

// Linear sRGB → LMS cone response
const RGB_TO_LMS: ReadonlyArray<readonly number[]> = [
  [0.4122214608, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883022599, 0.2817188376, 0.6299787005],
];

// LMS → linear sRGB (inverse of above)
const LMS_TO_RGB: ReadonlyArray<readonly number[]> = [
  [4.0767416621, -3.3077115906, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.7076147009],
];

// LMS' (cube-rooted) → OKLab
const LMS_PRIME_TO_OKLAB: ReadonlyArray<readonly number[]> = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
];

// OKLab → LMS' (inverse of above)
const OKLAB_TO_LMS_PRIME: ReadonlyArray<readonly number[]> = [
  [0.9999999984505198, 0.3963377921737679, 0.2158037580607588],
  [1.0000000086996028, -0.1055613423236564, -0.0638541747717059],
  [1.0000000095444298, -0.0894841821008142, -1.2914855378510604],
];

function mulMatVec(
  m: ReadonlyArray<readonly number[]>,
  v: readonly number[],
): number[] {
  return [
    m[0]![0]! * v[0]! + m[0]![1]! * v[1]! + m[0]![2]! * v[2]!,
    m[1]![0]! * v[0]! + m[1]![1]! * v[1]! + m[1]![2]! * v[2]!,
    m[2]![0]! * v[0]! + m[2]![1]! * v[1]! + m[2]![2]! * v[2]!,
  ];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// --- RGB ↔ OKLCH ---

export interface OKLCH {
  L: number; // perceived lightness 0..1
  C: number; // chroma
  H: number; // hue in radians
}

export function rgbaToOklch(c: ColorRgba): OKLCH {
  const lr = srgbToLinear(c.red / 255);
  const lg = srgbToLinear(c.green / 255);
  const lb = srgbToLinear(c.blue / 255);

  const lms = mulMatVec(RGB_TO_LMS, [lr, lg, lb]);
  const lmsPrime = lms.map(Math.cbrt);
  const lab = mulMatVec(LMS_PRIME_TO_OKLAB, lmsPrime);

  const a = lab[1]!;
  const b = lab[2]!;
  const C = Math.sqrt(a * a + b * b);
  const H = Math.atan2(b, a);

  return { L: lab[0]!, C, H };
}

export function oklchToRgba(oklch: OKLCH): ColorRgba {
  const a = oklch.C * Math.cos(oklch.H);
  const b = oklch.C * Math.sin(oklch.H);

  const lmsPrime = mulMatVec(OKLAB_TO_LMS_PRIME, [oklch.L, a, b]);
  const lms = lmsPrime.map((v) => v * v * v);
  const linear = mulMatVec(LMS_TO_RGB, lms);

  return new ColorRgba(
    Math.round(clamp01(linearToSrgb(clamp01(linear[0]!))) * 255),
    Math.round(clamp01(linearToSrgb(clamp01(linear[1]!))) * 255),
    Math.round(clamp01(linearToSrgb(clamp01(linear[2]!))) * 255),
  );
}

/**
 * Rotate the hue of a color in OKLCH space by the given number of degrees.
 * Positive = counter-clockwise on the hue wheel.
 * Returns a gamut-clamped sRGB color.
 */
export function rotateHue(color: ColorRgba, degrees: number): ColorRgba {
  // [LAW:dataflow-not-control-flow] Zero rotation is a no-op through the
  // full pipeline — same code path, degrees=0 produces identity.
  const oklch = rgbaToOklch(color);
  const radians = (degrees * Math.PI) / 180;
  oklch.H += radians;
  return oklchToRgba(oklch);
}
