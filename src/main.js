let gpuInfo = false;


async function main() {

  if (device) device.destroy();

  // let maxComputeInvocationsPerWorkgroup, maxBufferSize, f32filterable;

  // WebGPU Setup
  // if (!device) {
  adapter = await navigator.gpu?.requestAdapter();

  const maxComputeInvocationsPerWorkgroup = adapter.limits.maxComputeInvocationsPerWorkgroup;
  const maxComputeWorkgroupSizeX = adapter.limits.maxComputeWorkgroupSizeX;
  const maxComputeWorkgroupSizeY = adapter.limits.maxComputeWorkgroupSizeY;
  const maxComputeWorkgroupSizeZ = adapter.limits.maxComputeWorkgroupSizeZ;
  const maxComputeWorkgroupStorageSize = adapter.limits.maxComputeWorkgroupStorageSize;
  const maxBufferSize = adapter.limits.maxBufferSize;
  const f32filterable = adapter.features.has("float32-filterable");
  const textureTier2 = adapter.features.has("texture-formats-tier2");

  if (!gpuInfo) {
    gui.addGroup("deviceInfo", "Device info", `<pre>
maxBufferSize: ${maxBufferSize}
f32filterable: ${f32filterable}
</pre>
    `);
    gpuInfo = true;
  }

  device = await adapter?.requestDevice({
    requiredFeatures: [
      ...(adapter.features.has("timestamp-query") ? ["timestamp-query"] : []),
      ...(f32filterable ? ["float32-filterable"] : []),
      ...(textureTier2 ? ["texture-formats-tier2"] : []),
      // "shader-f16",
    ],
    requiredLimits: {
      maxComputeInvocationsPerWorkgroup: maxComputeInvocationsPerWorkgroup,
      maxComputeWorkgroupSizeX: maxComputeWorkgroupSizeX,
      maxComputeWorkgroupSizeY: maxComputeWorkgroupSizeY,
      maxComputeWorkgroupStorageSize: maxComputeWorkgroupStorageSize,
    }
  });

  // restart if device crashes
  device.lost.then((info) => {
    if (info.reason != "destroyed") {
      hardReset();
      console.warn("WebGPU device lost, reinitializing.");
    }
  });

  // }
  if (!device) {
    alert("Browser does not support WebGPU");
    document.body.textContent = "WebGPU is not supported in this browser.";
    return;
  }
  const context = canvas.getContext("webgpu");
  const swapChainFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device: device,
    format: swapChainFormat,
  });

  const newTexture = (name) => device.createTexture({
    size: TexSize,
    dimension: "2d",
    format: "rgba32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    label: `${name} texture`
  });

  // const colorMatchingData = cie1964_xyz_10deg_360_830;
  const colorMatchingData = cie1931_xyz_2deg_360_830;

  storage.colorMatchingTex = device.createTexture({
    size: [colorMatchingData.length / 4],
    dimension: "1d",
    format: "rgba32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    label: "color matching texture"
  });
  device.queue.writeTexture(
    { texture: storage.colorMatchingTex },
    colorMatchingData.buffer,
    {}, { width: colorMatchingData.length / 4 }
  );

  // storage.whitePointTex = device.createTexture({
  //   size: [cieD65_360_830.length],
  //   dimension: "1d",
  //   format: "r32float",
  //   usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  //   label: "white point texture"
  // });
  // device.queue.writeTexture(
  //   { texture: storage.whitePointTex },
  //   cieD65_360_830.buffer,
  //   {}, { width: cieD65_360_830.length }
  // );

  storage.lutTex = newTexture("lut");
  const views = Object.fromEntries(
    Object.entries(storage).filter(([key, value]) => value instanceof GPUTexture).map(([key, texture]) => [key, texture.createView()])
  );

  const uniformBuffer = uni.createBuffer(device);

  const newComputePipeline = (shaderCode, name, entryPoint = "main", consts = {}) =>
    device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({
          code: shaderCode,
          label: `${name} compute module`
        }),
        constants: consts,
        entryPoint: entryPoint
      },
      label: `${name} compute pipeline`
    });

  const clampSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  const filter = f32filterable ? "linear" : "nearest";

  const MieCSPipeline = newComputePipeline(MieCS, "Mie CS", "main");
  const MieCSBindgroup = device.createBindGroup({
    layout: MieCSPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: views.lutTex },
      { binding: 2, resource: clampSampler },
      { binding: 3, resource: views.colorMatchingTex },
    ],
    label: "Mie compute bind group"
  });

  const renderModule = device.createShaderModule({
    code: mainRenderShaderCode,
    label: "render module"
  });

  const renderPipeline = device.createRenderPipeline({
    label: 'main rendering pipeline',
    layout: 'auto',
    vertex: { module: renderModule },
    fragment: {
      module: renderModule,
      targets: [{ format: swapChainFormat }],
    }
  });

  const renderBindGroup = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: views.lutTex },
      // { binding: 1, resource: views.inputTex },
      // { binding: 1, resource: views.rowFreqTex },
      // { binding: 1, resource: views.sourceTex },
      { binding: 2, resource: clampSampler },
    ],
  });

  const copyRenderPipeline = device.createRenderPipeline({
    label: 'copy rendering pipeline',
    layout: 'auto',
    vertex: { module: renderModule },
    fragment: {
      module: renderModule,
      targets: [{ format: "rgba32float" }],
    }
  });

  const copyRenderBindGroup = device.createBindGroup({
    layout: copyRenderPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: views.lutTex },
      { binding: 2, resource: clampSampler },
    ],
  });


  const renderPassDescriptor = {
    label: 'render pass',
    colorAttachments: [
      {
        clearValue: [0, 0, 0, 1],
        loadOp: 'clear',
        storeOp: 'store',
      },
    ]
  };

  const filterStrength = 50;

  const MieComputeTimingHelper = new TimingHelper(device);
  const renderTimingHelper = new TimingHelper(device);

  downloadImg = () => {
    // uni.set("toneMapping", [0]);
    // uni.update(device.queue);
    
    const encoder = device.createCommandEncoder();
    const copyBuffer = device.createBuffer({
      label: "copy buffer",
      size: TexSize[0] * TexSize[1] * 4 * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer(
      { texture: storage.lutTex },
      { buffer: copyBuffer, bytesPerRow: TexSize[0] * 4 * 4 },
      TexSize
    );
    device.queue.submit([encoder.finish()]);
    
    let arrayBuffer;
    copyBuffer.mapAsync(GPUMapMode.READ).then(() => {
      arrayBuffer = copyBuffer.getMappedRange();
      console.log(arrayBuffer.byteLength);
      const data = new Float32Array(arrayBuffer);

      // Create a blob representing raw binary data
      const blob = new Blob([arrayBuffer], { type: "application/octet-stream" });
      
      // Generate a secure DOM URL referencing our memory block
      const url = URL.createObjectURL(blob);
      
      // Construct a temporary link element off-screen
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `MieLut.bin`;
      
      // Programmatically trigger the native browser download dialog
      anchor.click();
      
      // Clean up memory to avoid leaks
      URL.revokeObjectURL(url);
      copyBuffer.unmap();
      texture.destroy();
      copyBuffer.destroy();
    });
    // uni.set("toneMapping", [gui.io.toneMapping.value ? 1 : 0]);
    // uni.update(device.queue);
    uni.valuesChanged = true; // force rerender
  }
let frameCounter = 0;
  function render() {
    const startTime = performance.now();
    deltaTime += Math.min(startTime - lastFrameTime - deltaTime, 1e4) / filterStrength;
    const speedMultiplier = Math.min(deltaTime, 50);
    fps += (1e3 / deltaTime - fps) / filterStrength;
    lastFrameTime = startTime;
    uni.set("frameCounter", [frameCounter++]);
    gui.io.frameCounter(frameCounter);
uni.update(device.queue);
    if (true || frameCounter == 1) {
      const encoder = device.createCommandEncoder();

      const canvasTexture = context.getCurrentTexture();
      renderPassDescriptor.colorAttachments[0].view = canvasTexture.createView();

      const MieComputePass = MieComputeTimingHelper.beginComputePass(encoder);
      
      MieComputePass.setPipeline(MieCSPipeline);
      MieComputePass.setBindGroup(0, MieCSBindgroup);
      MieComputePass.dispatchWorkgroups(Math.ceil(TexSize[0] / WGSIZE), Math.ceil(TexSize[1] / WGSIZE));
      
      MieComputePass.end();

      const renderPass = renderTimingHelper.beginRenderPass(encoder, renderPassDescriptor);
      renderPass.setPipeline(renderPipeline);
      renderPass.setBindGroup(0, renderBindGroup);
      renderPass.draw(3);
      renderPass.end();

      device.queue.submit([encoder.finish()]);
      MieComputeTimingHelper.getResult().then(gpuTime => computeTime += (gpuTime / 1e6 - computeTime) / filterStrength);
      renderTimingHelper.getResult().then(gpuTime => renderTime += (gpuTime / 1e6 - renderTime) / filterStrength);
    }

    jsTime += (performance.now() - startTime - jsTime) / filterStrength;

    rafId = requestAnimationFrame(render);
  }

  perfIntId = setInterval(() => {
    gui.io.fps(fps.toFixed(1));
    gui.io.frameTime(deltaTime.toFixed(2));
    gui.io.jsTime(jsTime.toFixed(2));
    gui.io.computeTime(computeTime.toFixed(2));
    gui.io.renderTime(renderTime.toFixed(2));
  }, 100);
  rafId = requestAnimationFrame(render);
}

gui.updateAllVisibility();

uni.set("lutRes", TexSize);
uni.set("toneMapping", [1]);
uni.set("gain", [1]);
uni.set("contrast", [1]);

main();