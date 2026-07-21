

const uni = new Uniforms();
// uni.addUniform("resolution", "vec2f");
uni.addUniform("lutRes", "vec2f");
uni.addUniform("frameCounter", "f32");
uni.addUniform("toneMapping", "f32");

uni.finalize();

const storage = {
  lutTex: null,
};

const canvas = document.getElementById("_canvas");
canvas.style.imageRendering = "pixelated";

const gui = new GUI("WebGPU MiePlot", canvas);
const TexSize = [512, 256];
const WGSIZE = 8;

const resizeCanvas = (value = window.devicePixelRatio) => {
  // pixelRatio = value / window.innerHeight || 1;
  const minDim = Math.min(window.innerWidth / TexSize[0], window.innerHeight / TexSize[1]);
  canvas.style.width = `${minDim * TexSize[0]}px`;
  canvas.style.height = `${minDim * TexSize[1]}px`;
  canvas.width = canvas.height = value;
  // uni.set("resolution", [value]);
  gui.io.res([value, value]);
}



let adapter, device;

let downloadImg = () => {};

// Performance section
gui.addGroup("perf", "Performance");
gui.addStringOutput("res", "Resolution", "", "perf");
gui.addHalfWidthGroups("perfL", "perfR", "perf");
gui.addNumericOutput("fps", "FPS", "", 1, "perfL");
gui.addNumericOutput("frameTime", "Frame", "ms", 2, "perfL");
gui.addNumericOutput("jsTime", "JS", "ms", 2, "perfL");
gui.addNumericOutput("computeTime", "Mie", "ms", 2, "perfR");
gui.addNumericOutput("renderTime", "Render", "ms", 2, "perfR");

gui.addDropdown("canvasResolution", "Canvas resolution", [
  "1024",
  "512",
  "256",
  "128",
], "perf", null, (value) => resizeCanvas(parseInt(value)));
gui.addButton("download", "Download image", true, "perf", () => downloadImg());

gui.addDropdown("colorMatching", "Color matching", [
  "CIE 1931 2deg",
  "CIE 1964 10deg",
], "perf", null, async (value) => {
  const colorMatchingData = (value === "CIE 1931 2deg") ? cie1931_xyz_2deg_360_830 : cie1964_xyz_10deg_360_830;
  device.queue.writeTexture(
    { texture: storage.colorMatchingTex },
    colorMatchingData.buffer,
    {}, { width: colorMatchingData.length / 4 }
  );
});
gui.addCheckbox("toneMapping", "Tone mapping", true, "perf", (value) => uni.set("toneMapping", [value ? 1 : 0]));
gui.addGroup("info", "Info", `
  <div>
    Webgpu port of <a href="https://www.shadertoy.com/view/X3ySWd" target="_blank">GLSL Mie Plotter</a>
  </div>
`);
// Extra info
gui.addGroup("guiControls", "GUI controls", `
  <div>
    Click on section titles to expand/collapse
    <br>
    Hover on input labels for more info if applicable
    <br>
    Click to toggle between raw number and slider type input
    <br>
  </div>
`);


// requestAnimationFrame id, fps update id
let rafId, perfIntId;


// timing
let jsTime = 0, lastFrameTime = performance.now(), deltaTime = 10, fps = 0,
  computeTime = 0, dispersionTime = 0, renderTime = 0;

// handle resizing
window.onresize = window.onload = () => resizeCanvas(1024);