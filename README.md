# Vision

Vision is a Chromium-based browser extension for VLM (Vision Language Model) inference, which is fully local and runs directly on your browser.

Thanks to <a href="https://github.com/huggingface/transformers.js/">Transformers.js</a>, models can be run directly on your own internet browser, without the need for a server. All data is stored on your local device only.

Vision uses 🤗 <a href="https://huggingface.co/Qwen/Qwen2-VL-2B-Instruct">Qwen2-VL-2B-Instruct</a>, a small VLM by Qwen for visual analysis. For compatibility with Transformers.js, we use the model's <a href="https://huggingface.co/onnx-community/Qwen2-VL-2B-Instruct/">ONNX</a> weights instead.

A GPU with at least 2GB of VRAM and 8GB of system RAM is recommended for best performance.

## Features

Vision is a simple extension that allows users to either drag and drop/upload an image file for VLM inference. By default, the model is prompted to explain the given image.

![vision-extension-demo](https://github.com/user-attachments/assets/d76e42fc-dca8-4c84-a4c3-e17ce4106b61)

A universal switch helps to minimise unnecessary resource usage, as the model is only loaded into memory when the extension is swtiched on.

![vision-extension-switch](https://github.com/user-attachments/assets/95e1c6cf-5d08-44f8-9372-64c87468c35a)

## Deploying locally

To deploy locally, download the latest release and unzip it. Navigate to `chrome://extensions/` and select **Load unpacked**. You may need to turn on developer mode in order to see this option.

## Adjustments

1. Quants

To achieve best performance, the following default quantization settings are recommended:

- Decoder model: `q4`
- Token embeddings: `int8`
- Vision encoder: `int8`

To experiment with other quants, you can refer to 🤗 <a href="https://huggingface.co/docs/transformers.js/en/guides/dtypes">Using quantized models (dtypes)</a>

2. Prompt

The default prompt is `Describe this image.`, however changing this to `Explain this image.` makes the model output relevant factual information (although prone to hallucination) instead of simply describing the image visually.

3. Model

By default, `device: WebGPU` is used for model inference, which is supported on most modern browsers. On older hardware/browsers, inference might default to `device: cpu`, which is much slower. To avoid long processing times, it is recommended that a small vision model be used with quantization. In this implementation, Qwen2-VL-2B-Instruct is used as I was able to find a pre-configured repo on HuggingFace for the ONNX weights. For other models, you might need to perform manual conversion of weights. Note that `.safetensors` and `.gguf` weights are not supported here.

4. Output

For fast inference, the model output is limited to a maximum of 1024 tokens. This can be adjusted depending on your preference.

```js
const outputs = await model.generate({
  ...inputs,
  max_new_tokens: 1024,
});
```

## Issues

- [x] Memory leak when spamming the main on/off toggle
- [ ] Trying to load a different model does not free up resources used by the previous model

Right now, turning off the extension calls `model.dispose()`, which should force garbage collection, but upon testing this does not seem to free up resources. For now, the only way to free up memory and VRAM is to close and reopen the browser.

Only `Transformers.js<=3.2.4` is supported. Newer versions break the extension completely. In the latest release, Transformers.js v3.2.4 is used.

In this extension, Manifest V2 is being used which is deprecated. This implementation uses a background script. The newer <a href="https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3">Manifest V3</a> shifts towards the use of service workers instead, which may fix the resource hogging issues.

## Credits

Most of the Chrome Extension API references in this project is generated by <a href="https://www.anthropic.com/news/claude-3-7-sonnet">Claude 3.7 Sonnet</a>.
