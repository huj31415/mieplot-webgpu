const MieCS = /* wgsl */`
${uni.uniformStruct}

@group(0) @binding(0) var<uniform> uni: Uniforms;
@group(0) @binding(1) var output: texture_storage_2d<rgba32float, read_write>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var colorMatchingTex: texture_1d<f32>;

// from https://www.shadertoy.com/view/X3ySWd
// -------------------------------------------------------------------------
// USER VARIABLES
// -------------------------------------------------------------------------
// const lutRes = vec2f(512.0,256.0); //resolution of the lookup texture

// min and max radius of the droplet. >0.1 micron is rayleigh territory while 3000μm (3.0 mm)
// are largest observed rain droplets.

const MIN_SIZE = 0.02; // r in micron (top of LUT)
const MAX_SIZE = 1800.0; //2000.0; // r in micron (bottom of LUT)
const SIZE_JITTER = 0.025; // droplet size jitter (approximates a collection of droplets)

const MIN_WAVELENGTH = 380.0; // 𝜆 minimum light wavelength in nanometer; 0.38 micron
const MAX_WAVELENGTH = 700.0; // 𝜆 maximum light wavelength in nanometer; 0.7 micron

const MIN_ANGLE = 0.0; //degrees (left of LUT)
const MAX_ANGLE = 180.0; //degrees (right of LUT)

// -------------------------------------------------------------------------
// OUTPUT LUT VARIABLES
// -------------------------------------------------------------------------

// Weird dual exposure because the left side of LUT is much brighter than the right
const EXPOSURE = exp2(0.0); //exposure
// -------------------------------------------------------------------------
// END OF USER VARIABLES
// -------------------------------------------------------------------------

// general constants
const PI = 3.14159265;
const ln10 = 2.3025850929;

// RNG----------------------------------------------------------------------
fn pcg3d(i: vec3u) -> vec3u {
  var v = i * 1664525u + 1013904223u;

  // v.x += v.y*v.z;
  // v.y += v.z*v.x;
  // v.z += v.x*v.y;

  v += v.yzx * v.zxy;

  v ^= v >> vec3u(16u);

  // v.x += v.y*v.z;
  // v.y += v.z*v.x;
  // v.z += v.x*v.y;

  v += v.yzx * v.zxy;
  return v;
}

fn pcg3d_f(v: vec3f) -> vec3f
{
  return (1.0 / f32(0xffffffffu)) * vec3f(pcg3d( bitcast<vec3u>(v) ));
}

//uniformly distributed, normalized rand, [0;1]
fn nrand(n: vec3f) -> f32
{
  return pcg3d_f(n).x;
}

fn n4rand(n: vec3f) -> f32
{
	let nrnd0 = nrand( n + 0.07 );
	let nrnd1 = nrand( n + 0.11 );	
	let nrnd2 = nrand( n + 0.13 );
	let nrnd3 = nrand( n + 0.17 );
	return (nrnd0+nrnd1+nrnd2+nrnd3) / 4.0;
}
// -------------------------------------------------------------------------

// Functions of complex variables.
fn cmul(l: vec2f,r: vec2f) -> vec2f
{
  return vec2f(l.x*r.x - l.y*r.y, dot(l, r.yx));
}

fn cdiv(l: vec2f,r: vec2f) -> vec2f
{
  return vec2f(dot(l, r), l.y*r.x - l.x*r.y) / dot(r, r);
}

fn csin(z: vec2f) -> vec2f
{
  return vec2f(sin(z.x)*cosh(z.y), cos(z.x)*sinh(z.y));
}

fn ccos(z: vec2f) -> vec2f
{
  return vec2f(cos(z.x)*cosh(z.y),-sin(z.x)*sinh(z.y));
}

fn c_abs(c: vec2f) -> f32
{
	return length(c);
}

//value range functions, need to rename them

//0-1 value to min-max range
fn val_lin_scale(val: f32, minVal: f32, maxVal: f32) -> f32
{
  let scale = 1.0 / (maxVal - minVal);
  let valRange = (val / scale) + minVal;
  return valRange;
}

//range to linear 0-1 value
fn linearScale(v: f32, minVal: f32, maxVal: f32) -> f32 {
  // Ensure the input value is within the valid range
  let val = clamp(v, minVal, maxVal);
  // Normalize the value to the [0, 1] range
  return (val - minVal) / (maxVal - minVal);
}

//0-1 value to min-max log range
fn val_log_scale(val: f32, minVal: f32, maxVal: f32) -> f32
{
  let lowLog = log(minVal);
  let highLog = log(maxVal);
  let scale = (highLog - lowLog);
  let valLogRange = exp(fma(val, scale, lowLog));
  return valLogRange;
}

//range to log 0-1 value
fn linearToLogScale(v: f32, minVal: f32, maxVal: f32) -> f32 {
  // Ensure the input value is within the valid range
  let val = max(v, minVal);

  // Calculate the logarithmic value
  let logMin = log(minVal);
  let logMax = log(maxVal);
  let logVal = log(val);

  // Normalize the logarithmic value to the [0, 1] range
  return (logVal - logMin) / (logMax - logMin);
}

// IOR 

// =========================================================================
// CORRECTED REFRACTIVE INDEX COEFFICIENTS
// =========================================================================
struct sellmeier_coeffs {
  B: vec3f,
  C: vec3f
};

// Distilled water at 21.5°C (Daimon & Masumura 2007) - CORRECTED
// Valid from 182 nm to 1129 nm
// Reference: https://doi.org/10.1364/AO.46.003811
const water_21p5C = sellmeier_coeffs(
  vec3f(0.5689093832, 0.1719708856, 0.02062501582),
  vec3f(0.005110301794, 0.01825180155, 0.02624158904)
);

// Distilled water at 20.0°C (Daimon & Masumura 2007)
const water_20C = sellmeier_coeffs(
  vec3f(0.5684027565, 0.1726177391, 0.02086189578),
  vec3f(0.005101829712, 0.01821153936, 0.02620722293)
);

// Your original coefficients (source unknown - possibly 19°C?)
const water_original = sellmeier_coeffs(
  vec3f(0.5672526103, 0.1736581125, 0.02121531502),
  vec3f(0.005085550461, 0.01814938654, 0.02617260739)
);

// BK-7 borosilicate crown glass - CORRECT
// Standard Schott coefficients
const glass_BK7 = sellmeier_coeffs(
  vec3f(1.03961212, 0.231792344, 1.01046945),
  vec3f(0.00600069867, 0.0200179144, 103.560653)
);

// Air at 15°C, 101325 Pa - SIMPLIFIED
// Note: Air is better modeled with Edlén or Ciddor equations
// This is a simplified 2-term Sellmeier for visible range
const air_15C = sellmeier_coeffs(
  vec3f(0.05792105, 0.00167917, 0.0),
  vec3f(0.00238185, 0.0000767, 0.0)
);

// =========================================================================
// SELLMEIER EQUATION (Standard 3-term)
// =========================================================================
// Lambda must be in micrometers!
fn sellmeier(s: sellmeier_coeffs, lambda_um: f32) -> f32 {
  let l2 = lambda_um * lambda_um;
  // let n2 = 1.0
  //     + (s.B1 * l2) / (l2 - s.C1)
  //     + (s.B2 * l2) / (l2 - s.C2)
  //     + (s.B3 * l2) / (l2 - s.C3);
  let n2 = 1.0 + dot(s.B * l2 / (l2 - s.C), vec3f(1.0));
  return sqrt(max(n2, 1.0)); // Prevent sqrt of negative
}

// =========================================================================
// WATER REFRACTIVE INDEX - RECOMMENDED FUNCTION
// =========================================================================
// Input: wavelength in nanometers (380-700 nm for visible)
// Output: real refractive index
fn water_refractive_index(wavelength_nm: f32) -> f32 {
  // Convert nm to µm for Sellmeier equation
  let lambda_um = wavelength_nm * 0.001;
  
  // Use 20°C data (close to room temperature)
  return sellmeier(water_20C, lambda_um);
}

// =========================================================================
// IMAGINARY REFRACTIVE INDEX OF WATER (Extinction Coefficient)
// =========================================================================
// Based on Pope & Fry (1997) and Hale & Querry (1973) data
// Valid for visible spectrum (380-700 nm)
fn water_extinction_coefficient(lambda_nm: f32) -> f32 {
  // For visible light, water is extremely transparent
  // k ranges from ~1e-9 at 400nm to ~1e-6 at 700nm
  
  // Piecewise approximation based on measured data
  if (lambda_nm < 400.0) {
    // UV region: slightly higher absorption
    return 1e-8;
  } else if (lambda_nm < 500.0) {
    // Blue-green: minimal absorption
    let t = (lambda_nm - 400.0) / 100.0;
    return mix(1e-9, 5e-9, t);
  } else if (lambda_nm < 600.0) {
    // Green-yellow: still very low
    let t = (lambda_nm - 500.0) / 100.0;
    return mix(5e-9, 2e-8, t);
  } else {
    // Red: increasing absorption
    let t = (lambda_nm - 600.0) / 100.0;
    return mix(2e-8, 1e-7, t * t); // Quadratic increase
  }
}

// =========================================================================
// COMPLEX REFRACTIVE INDEX FOR MIE SCATTERING
// =========================================================================
fn water_complex_refractive_index(wavelength_nm: f32) -> vec2f {
  let n = water_refractive_index(wavelength_nm);
  let k = water_extinction_coefficient(wavelength_nm);
  return vec2f(n, k);
}


// gamma correct
fn linear2srgb(rgb: vec3f) -> vec3f
{
  return mix(12.92 * rgb, 1.055 * pow(rgb, vec3f(1.0/2.4))-0.055, step(vec3f(0.0031308), rgb));
}

// from https://www.shadertoy.com/view/DtlfRX
fn xFit_1931(wave: f32) -> f32 {
  let t1 = (wave-442.0)*select(0.0374, 0.0624, wave<442.0);
  let t2 = (wave-599.8)*select(0.0323, 0.0264, wave<599.8);
  let t3 = (wave-501.1)*select(0.0382, 0.0490, wave<501.1);
  return 0.362*exp(-0.5*t1*t1) + 1.056*exp(-0.5*t2*t2)- 0.065*exp(-0.5*t3*t3);
}
fn yFit_1931(wave: f32) -> f32 {
  let t1 = (wave-568.8)*select(0.0247, 0.0213, wave<568.8);
  let t2 = (wave-530.9)*select(0.0322, 0.0613, wave<530.9);
  return 0.821*exp(-0.5*t1*t1) + 0.286*exp(-0.5*t2*t2);
}
fn zFit_1931(wave: f32) -> f32 {
  let t1 = (wave-437.0)*select(0.0845, 0.0278, wave<437.0);
  let t2 = (wave-459.0)*select(0.0385, 0.0725, wave<459.0);
  return 1.217*exp(-0.5*t1*t1) + 0.681*exp(-0.5*t2*t2);
}

fn wavelength2xyz(w: f32) -> vec3f {
  return vec3f( xFit_1931(w), yFit_1931(w), zFit_1931(w) );
}
fn wavelength2xyzLut(w: f32) -> vec3f {
  let lookupUV = (w - 360) / (830 - 360);
  let xyz = textureSampleLevel(colorMatchingTex, texSampler, lookupUV, 0.0).xyz;
  return xyz;
}
    
fn xyz2rgb(XYZ: vec3f) -> vec3f {
  // CIE RGB
	return mat3x3f(
    2.3706743, -0.5138850, 0.0052982,
    -0.9000405, 1.4253036, -0.0146949,
    -0.4706338, 0.0885814, 1.0093968
  ) * XYZ;
  // sRGB D65
  // return transpose(mat3x3f(
  //   3.2404542, -1.5371385, -0.4985314,
  //   -0.9692660,  1.8760108,  0.0415560,
  //   0.0556434, -0.2040259,  1.0572252
  // )) * XYZ;
}


// Public Domain under http://unlicense.org, see link for details.

// GLSL implementation of computations for Mie scattering by a homogeneous
// sphere, mostly adapted from BHMIE.f by Craig F. Bohren and
// Donald R. Huffman (with modifications by Bruce T. Draine) with some
// elements of MIEV0.f by Warren J. Wiscombe.

// References: 
//     [1] Bohren, Craig F. and Donald Ray Huffman. “Absorption and Scattering of Light by Small Particles.” (1998).
//     [2] W. J. Wiscombe, "Improved Mie scattering algorithms," Appl. Opt. 19, 1505-1509 (1980)
//         https://opg.optica.org/ao/fulltext.cfm?uri=ao-19-9-1505&id=23949
//     [3] Lentz, William. (1976). Generating Bessel Functions In Mie Scattering Calculations Using Continued Fractions. Applied optics. 15. 668-71. 10.1364/AO.15.000668. 
//     [4] Du, H. (2004). Mie-scattering calculation. Applied Optics, 43(9), 1951. doi:10.1364/ao.43.001951 

//==============================================================================


//==============================================================================
// Function for calculating Mie scattering.

// Input:
//     x   - size parameter, 2*pi*r/lambda.
//           NOTE: 2*pi*Nmedium*r/lambda, for arbitrary medium.
//     m   - complex relative refraction index, Nparticle/Nmedium.
//           IMPORTANT: following [1], we expect Im(m)>=0, whereas
//           many texts adopt Im(m)<=0 convention.
//     mu  - cosine of the scattering angle.
// Output: matrix with the following 4 columns:
//     [0] - S1 element of the amplitude scattering matrix (complex number).
//     [1] - S2 element of the amplitude scattering matrix (complex number).
//     [2] - vec2f(Qext,Qsca) - efficiency factors for extinction and scattering.
//     [3] - vec2f(Gsca,0) - asymmetry parameter.

fn mie(x: f32, m: vec2f, mu: f32) -> mat4x2f
{
  var y = x * m;
  var pi0 = 0.0; var pi1=1.0; var pi: f32;
  var s1 = vec2f(0.0,0.0);
  var s2 = vec2f(0.0,0.0);
  var tau: f32;
  var psi0 = cos(x);
  var psi1 = sin(x);
  var chi0 =-psi1;
  var chi1 = psi0;
  var xi1 = vec2f(psi1,-chi1);
  // var qext = 0.0;
  var qsca = 0.0;
  var gsca = 0.0;
  var an = vec2f(0.0,0.0);
  var bn = vec2f(0.0,0.0);
  var an1 = vec2f(0.0,0.0);
  var bn1 = vec2f(0.0,0.0);
  
  // vec2f D=cdiv(csin(y)-cmul(y,cmul(y,csin(y))+ccos(y)),cmul(y,cmul(y,ccos(y))-csin(y)));
  // The original expression is
  //     D=(sin(z)-z*cos(z)-z*z*sin(z))/(z*z*cos(z)-z*sin(z))
  // which we evaluate avoiding overflow.
  let tc = cos(y.x);
  let ts = sin(y.x);
  
  let hc = 1.0 + exp(-2.0 * y.y);
  let hs = 1.0 - exp(-2.0 * y.y);

  let cs = vec2f(ts*hc, tc*hs);
  let cc = vec2f(tc*hc,-ts*hs);
  var D = cdiv(cs - cmul(y, cmul(y, cs) + cc), cmul(y, cmul(y, cc) - cs));

  let nstop = i32(round(x + 4.0 * pow(x, 0.3333) + 2.0));
  
  for (var k = 0; k < nstop; k++) {
    let n = f32(k + 1);
    let f_n = (2.0 * n + 1.0) / (n * (n + 1.0));
    
    let psi = (2.0 * n - 1.0) * psi1 / x - psi0;
    let chi = (2.0 * n - 1.0) * chi1 / x - chi0;
    let xi = vec2f(psi,-chi);

    let an1 = an;
    let bn1 = bn;

    //Compute AN and BN:
    let D_m = cdiv(D, m);
    let md = cmul(m, D);
    an = (D_m + vec2f(n/x, 0.0)) * psi - vec2f(psi1, 0.0);
    an = cdiv(an, (cmul(D_m + vec2f(n / x, 0.0), xi) - xi1));
    bn = (md + vec2f(n/x, 0.0)) * psi - vec2f(psi1, 0.0);
    bn = cdiv(bn, (cmul(md + vec2f(n / x, 0.0), xi) - xi1));
    
    //Augment sums for Qsca and g=<cos(theta)>
    // qext = qext + ((2. * n + 1.) * (an.x + bn.x));
    qsca += ((2. * n + 1.) * (dot(an, an) + dot(bn, bn)));
    gsca += ((2. * n + 1.) / (n * (n + 1.)) * dot(an, bn));
    gsca += ((n - 1.) * (n + 1.) / n) * (dot(an1, an) + dot(bn1, bn));
    
    pi = pi1;
    tau = n * mu * pi - (n + 1.) * pi0;
    s1 = s1 + f_n * (an * pi + bn * tau);
    s2 = s2 + f_n * (an * tau + bn * pi);
    
    psi0 = psi1;
    psi1 = psi;
    chi0 = chi1;
    chi1 = chi;
    xi1 = vec2f(psi1, -chi1);
    
    pi1 = ((2. * n + 1.) * mu * pi - (n + 1.) * pi0) / n;
    pi0 = pi;
    
    let n1_y = cdiv(vec2f(n + 1., 0.0), y);
    D = cdiv(vec2f(1.0, 0.0), (n1_y - D)) - n1_y;
  }
  
  gsca = 2.0 * (gsca) / qsca;
  // qsca = (2.0 / (x * x)) * qsca;    
  // qext = (4.0 / (x * x)) * s1.x;
  let qback = pow(c_abs(s1) / x, 2.0) / PI;
  
  return mat4x2f(s1, s2, (2.0 / (x * x)) * vec2f(2.0 * s1.x, qsca), vec2f(gsca, qback));
}

// Approximation of scattering for small x.
// Recommended for |m|*x<0.1.
// Meaning of input and output are the same as above.
fn mie_rayleigh(x: f32, m: vec2f, mu: f32) -> mat4x2f
{
  let m2 = cmul(m, m);
  let x2 = x*x;
  let x3 = x2*x;
  let x4 = x3*x;
  let D = m2 + vec2f(2.0,0.0)
    + (vec2f(1.0,0.0) - 0.7 * m2) * x2
    - x4 / 1400.0 * (cmul(m2, (8.0 * m2 - vec2f(385.0,0.0))) + vec2f(350.0, 0.0))
    + x3* cmul(vec2f(0.0, 2.0/3.0), m2 - vec2f(1.0,0.0)) * (1.0 - 0.1 * x2);

  let a1 = cmul(cmul(vec2f(0.0, 2.0/3.0), m2 - vec2f(1.0,0.0)),
    cdiv(vec2f(1.0 - 0.1 * x2, 0.0) + x4 / 1400.0 * (4.0 * m2 + vec2f(5.0, 0.0)), D));

  let b1 = cmul(cmul(vec2f(0.0, x2 / 45.0), (m2 - vec2f(1.0, 0.0))), cdiv(
    vec2f(1.0,0.0) + x2 / 70.0 * (2.0 * m2 - vec2f(5.0, 0.0)),
    vec2f(1.0,0.0) - x2 / 30.0 * (2.0 * m2 - vec2f(5.0, 0.0))
  ));

  let a2 = cmul(cmul(vec2f(0.0, x2 / 15.0), (m2 - vec2f(1.0,0.0))), cdiv(
    vec2f(1.0 - x2 / 14.0, 0.0),
    2.0 * m2 + vec2f(3.0, 0.0) - x2 / 14.0 * (2.0 * m2 - vec2f(7.0,0.0))
  ));

  let T = dot(a1, a1) + dot(b1, b1) + 5.0 / 3.0 * dot(a2, a2);
  let qext = x * (a1 + b1 + 5.0/3.0 * a2).x;
  let qsca = x4 * T;
  let gsca = 1.0 / T * dot(a1, a2+b1);
  let s1 = 3.0/2.0 * x3 * (a1 + (b1 + 5.0/3.0 * a2) * mu);
  let s2 = 3.0/2.0 * x3 * (b1 + a1 * mu + 5.0/3.0 * a2 * (2.0 * mu * mu - 1.0));
  return mat4x2f(s1, s2, 6.0 * vec2f(qext,qsca), vec2f(gsca,0.0));
}

//==============================================================================


fn mieplot(
  wavelength_nm: f32,   // wavelength in nm (e.g., 380-700)
  theta: f32,           // scattering angle in radians (0 to π)
  r_um: f32             // particle radius in micrometers
) -> vec2f // f32
{
  // -------------------------------------------------------------------------
  // 1. Get complex refractive index of water droplet
  // -------------------------------------------------------------------------
  // For cloud droplets in air, we need RELATIVE refractive index
  let n_air = 1.000293;
  let m = water_complex_refractive_index(wavelength_nm) / n_air;
  
  // -------------------------------------------------------------------------
  // 2. Calculate size parameter and scattering angle
  // -------------------------------------------------------------------------
  let lambda_um = wavelength_nm * 0.001;
  let x = (2.0 * PI * r_um) / lambda_um;
  let mu = cos(theta);
  
  // -------------------------------------------------------------------------
  // 3. Choose appropriate scattering calculation
  // -------------------------------------------------------------------------
  // let F = (x < 0.1) 
  //   ? mie_rayleigh(x, m, mu) 
  //   : mie(x, m, mu);
  var F: mat4x2f;
  if (x < 0.1) {
    F = mie_rayleigh(x, m, mu);
  } else {
    F = mie(x, m, mu);
  }
  let s1 = F[0];
  let s2 = F[1];
  let Qsca = F[2].y;
  let Qext = F[2].x;
  
  // -------------------------------------------------------------------------
  // 4. Calculate scattered intensities
  // -------------------------------------------------------------------------
  let i1 = dot(s1, s1);  // |S1|²
  let i2 = dot(s2, s2);  // |S2|²
  
  // -------------------------------------------------------------------------
  // 5. CORRECTED PHASE FUNCTION (Bohren & Huffman Eq. 4.74)
  // -------------------------------------------------------------------------
  // The normalized phase function is:
  //     p(θ) = (4π / (k² · Csca)) · (|S1|² + |S2|²) / 2
  //
  // Where:
  //     k = 2π/λ
  //     Csca = Qsca · π · r²
  //
  // Substituting:
  //     p(θ) = (4π / ((2π/λ)² · Qsca · π · r²)) · (|S1|² + |S2|²) / 2
  //          = (4π · λ² / (4π² · Qsca · π · r²)) · (|S1|² + |S2|²) / 2
  //          = (λ² / (π² · Qsca · r²)) · (|S1|² + |S2|²) / 2
  //          = (1 / (k² · Qsca · r²)) · (|S1|² + |S2|²) · 2
  
  let k = (2.0 * PI) / lambda_um;
  
  let phase = (2.0 / (k*k * r_um*r_um * Qsca)) * (i1 + i2);
  // let W = PI * r_um*r_um * Qsca;
  // let phase = (i1 + i2) * 0.5 / W;
  
  return max(vec2f(phase, Qext), vec2f(0.0));
}

// -------------------------------------------------------------------------
// Validation function to test normalization
// -------------------------------------------------------------------------
fn validate_normalization(wavelength_nm: f32, r_um: f32) -> f32
{
  // Integrate: (1/2) ∫[0 to π] p(θ) sin(θ) dθ
  // This should equal 1.0 for a properly normalized phase function
  
  let N = 256;
  var sum = 0.0;
  
  for (var i = 0; i < N; i++)
  {
    let theta = (f32(i) + 0.5) / f32(N) * PI;
    let phase = mieplot(wavelength_nm, theta, r_um).x;
    sum += phase * sin(theta);
  }
  
  // Monte Carlo estimate: (domain_size / N) * sum
  // Domain is [0, π], so domain_size = π
  // Include the 1/2 factor from the normalization condition
  let integral = 0.5 * (PI / f32(N)) * sum;
  
  return integral;
}

// -------------------------------------------------------------------------
// Test multiple cases
// -------------------------------------------------------------------------
fn test_normalization(fragCoord: vec2f) -> vec4f
{
  let uv = fragCoord / uni.lutRes;
  
  // Test different particle sizes and wavelengths
  let wavelength = mix(400.0, 700.0, uv.x);
  let size = mix(1.0, 20.0, uv.y);
  
  let integral = validate_normalization(wavelength, size);
  
  // Visualize error
  let error = abs(integral - 1.0);
  
  var color: vec3f;
  if (error < 0.01) {
    color = vec3f(0.0, 1.0, 0.0);  // Green: good
  } else if (error < 0.05) {
    color = vec3f(1.0, 1.0, 0.0);  // Yellow: acceptable
  } else {
    color = vec3f(1.0, 0.0, 0.0);  // Red: bad
  }
  
  // Show the actual integral value
  
  // Debug: show exact value in a specific pixel
  // if (distance(fragCoord, vec2f(10.0, 10.0)) < 1.0) {
  //   return vec4f(vec3f(integral), 1.0);
  // }
  return vec4f(color * integral, 1.0);
}


// x: input u, y: output (angle / PI)
const points = array<vec2f, 2>(
  vec2f(0.2, 0.2),
  vec2f(0.4, 0.6)
);
const m0 = points[0].y / points[0].x;
const m1 = (points[1].y - points[0].y) / (points[1].x - points[0].x);
const m2 = (1.0 - points[1].y) / (1.0 - points[1].x);

fn EncodeAngle(u: f32) -> f32 {
  if (u < points[0].x) {
    return m0 * u;
  }
  if (u < points[1].x) {
    return points[0].y + m1 * (u - points[0].x);
  }
  return points[1].y + m2 * (u - points[1].x);
}

// ============================================================================
// Main Image
// ============================================================================

const bias = 5.0;
const scaling = PI / log(bias + 1.0);
const golden = 0.5 * (sqrt(5.0) - 1.0);

@compute @workgroup_size(${WGSIZE}, ${WGSIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let uv = vec2f(gid.xy) / uni.lutRes;
  let seed = vec3f(uv.xy, uni.frameCounter);
  
  // -------------------------------------------------------------------------
  // 1. Sample wavelength uniformly across visible spectrum
  // -------------------------------------------------------------------------
  let wavelength = mix(MIN_WAVELENGTH, MAX_WAVELENGTH, ((uni.frameCounter + nrand(seed)) * golden) % 1.0);
  // let wavelength = mix(MIN_WAVELENGTH, MAX_WAVELENGTH, select((uni.frameCounter + nrand(seed)) * golden) % 1.0, (uni.frameCounter * 1e-3) % 1, uni.frameCounter <= 1000));
  // let wavelength = mix(MIN_WAVELENGTH, MAX_WAVELENGTH, nrand(seed));
  
  // -------------------------------------------------------------------------
  // 2. Sample particle size on logarithmic scale with jitter
  // -------------------------------------------------------------------------
  let rn = n4rand(seed);
  var s = ((1.0 - uv.y) + (rn * 2.0 - 1.0) * SIZE_JITTER);
  let size = val_log_scale(s, MIN_SIZE, MAX_SIZE);
  
  // -------------------------------------------------------------------------
  // 3. Sample scattering angle
  // -------------------------------------------------------------------------
  // let theta = PI - acos(uv.x * 2.0 - 1.0);
  // let theta = PI * (0.5 + 0.5 * tan(0.5 * PI * (uv.x - 0.5)));
  // let theta = 0.5 * PI * (smoothstep(0.0, 1.0, uv.x) + uv.x);
  // let theta = 0.5 * (1 - cos(PI * uv.x)) * PI;
  // let theta = PI * pow(uv.x, 0.75);

  // inverse is (exp(theta / scaling) - 1) * 0.5 / bias
  let theta = scaling * log(bias * uv.x + 1.0);

  // let theta = EncodeAngle(uv.x) * PI;
  // let theta = val_lin_scale(uv.x, MIN_ANGLE, MAX_ANGLE) * PI / 180;

  // -------------------------------------------------------------------------
  // 4. Calculate Mie phase function
  // -------------------------------------------------------------------------
  let phase = mieplot(wavelength, theta, size);
  // phase = max(phase, 0.0);
  
  // -------------------------------------------------------------------------
  // 5. Convert to XYZ->RGB color space
  // -------------------------------------------------------------------------
  var RGB = vec4f(xyz2rgb(wavelength2xyzLut(wavelength) * phase.x), phase.y);
  // wavelength2xyzLut(wavelength);
  
  // -------------------------------------------------------------------------
  // 6. Progressive accumulation (Monte Carlo integration)
  // -------------------------------------------------------------------------
  let previous = textureLoad(output, gid.xy);
  // let blend = 1.0 / f32(uni.frameCounter + 1);
  // RGB = mix(previous, RGB, blend);
  RGB += previous * uni.frameCounter;
  RGB /= uni.frameCounter + 1;

  // -------------------------------------------------------------------------
  // 7. Output
  // -------------------------------------------------------------------------
  // RGB = test_normalization(vec2f(gid.xy));
  textureStore(output, gid.xy, RGB);
  // textureStore(output, gid.xy, vec4f(wavelength2xyzLut(uv.x * (MAX_WAVELENGTH - MIN_WAVELENGTH) + MIN_WAVELENGTH), 1.0));
}
`;



const mainRenderShaderCode = /* wgsl */`
${uni.uniformStruct}

@group(0) @binding(0) var<uniform> uni: Uniforms;
@group(0) @binding(1) var output: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) fragCoord: vec2f,
};

const pos = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0)
);

fn linear2srgb(color: vec4f) -> vec4f {
  let cutoff = color.rgb < vec3f(0.0031308);
  let higher = 1.055 * pow(color.rgb, vec3f(1.0 / 2.4)) - 0.055;
  let lower = 12.92 * color.rgb;
  return vec4f(select(higher, lower, cutoff), color.a);
}

fn AgxDefaultContrastApprox(x: vec3f) -> vec3f {
	return (((((15.5 * x - 40.14) * x + 31.96) * x - 6.868) * x + 0.4298) * x + 0.1191) * x - 0.00232;		
}

fn AgxCurve(color: vec3f) -> vec3f {
	let hev = 14 * 0.5;
	let midGrey = 0.18;
	let c = (clamp(log2(color / midGrey), vec3f(-hev), vec3f(hev)) + hev) / 14;
	return AgxDefaultContrastApprox(c);
}

fn AgX(c: vec3f) -> vec3f {
  var color = c;
	color *= 2.3;
  // abney effect
  color *= mat3x3f(
    0.99999976, -1.26657e-7, -1.29064e-9,
    1.67316e-8, 0.99999976, -5.32026e-9,
    -0.00725587, 6.47740e-9, 1.00725580
  );

	color *= mat3x3f(
    0.842479062253094, 0.0784335999999992, 0.0792237451477643,
    0.0423282422610123, 0.878468636469772, 0.0791661274605434,
    0.0423756549057051, 0.0784336, 0.879142973793104
  );
  color = AgxCurve(color);
	color *= mat3x3f(
    1.19687900512017, -0.0980208811401368, -0.0990297440797205,
    -0.0528968517574562, 1.15190312990417, -0.0989611768448433,
    -0.0529716355144438, -0.0980434501171241, 1.15107367264116
  );
	return color;
}

@vertex
fn vs(@builtin(vertex_index) vIdx: u32) -> VertexOut {
  let currentPos = pos[vIdx];
  return VertexOut(vec4f(currentPos, 0.0, 1.0), 0.5 * (currentPos + 1.0));
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  var color = textureSample(output, texSampler, input.fragCoord).rgb;
  color *= uni.gain;
  color = mix(vec3f(0.5), color, uni.contrast);
  if (uni.toneMapping == 1) {
    return vec4f(saturate(AgX(color)), 1.0);
  }
  // return vec4f(1.0 - exp(-color), 1.0);
  return vec4f(color, 1.0);
}
`;

const directRenderShaderCode = /* wgsl */`
${uni.uniformStruct}

// @group(0) @binding(0) var<uniform> uni: Uniforms;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) fragCoord: vec2f,
};

const pos = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0)
);

@vertex
fn vs(@builtin(vertex_index) vIdx: u32) -> VertexOut {
  let currentPos = pos[vIdx];
  return VertexOut(vec4f(currentPos, 0.0, 1.0), 0.5 * (currentPos + 1.0));
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4f {
  // return log(textureSample(freqTex, texSampler, input.fragCoord * (uni.resolution / uni.resolution.y))) / 1e1;
  return textureSample(srcTex, texSampler, input.fragCoord);
}
`;