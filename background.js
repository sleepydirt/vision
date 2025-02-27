import {
  AutoProcessor,
  Qwen2VLForConditionalGeneration,
  RawImage,
} from "./lib/transformers.min.js";

// Global variables to store the model and processor
let processor = null;
let model = null;
let isModelLoaded = false;
let isLoadingModel = false;
let pendingRequests = {};

// Load model and processor (called once)
async function loadModel() {
  if (isModelLoaded || isLoadingModel) return;

  try {
    isLoadingModel = true;
    console.log("Loading model...");

    const model_id = "onnx-community/Qwen2-VL-2B-Instruct";
    processor = await AutoProcessor.from_pretrained(model_id);
    model = await Qwen2VLForConditionalGeneration.from_pretrained(model_id, {
      device: "webgpu",
    });

    isModelLoaded = true;
    console.log("Model loaded successfully");
    return { success: true };
  } catch (error) {
    console.error("Error loading model:", error);
    return { success: false, error: error.message };
  } finally {
    isLoadingModel = false;
  }
}

// Function to unload model and free memory
async function unloadModel() {
  if (!isModelLoaded) return { success: true };

  console.log("Unloading model...");

  try {
    // Set state variables first to prevent further usage
    isModelLoaded = false;

    // Try to dispose resources with extra error handling
    if (model) {
      try {
        if (typeof model.dispose === "function") {
          await model.dispose();
        }
      } catch (disposeError) {
        console.warn(
          "Error during model dispose, continuing cleanup:",
          disposeError
        );
        // Continue with cleanup despite this error
      }
      model = null;
    }

    if (processor) {
      try {
        if (typeof processor.dispose === "function") {
          await processor.dispose();
        }
      } catch (disposeError) {
        console.warn(
          "Error during processor dispose, continuing cleanup:",
          disposeError
        );
      }
      processor = null;
    }

    // Clear any cached data
    pendingRequests = {};

    // Force a garbage collection hint
    setTimeout(() => {
      const temp = new Array(1000).fill("cleanup");
      temp.length = 0;
    }, 100);

    console.log("Model cleanup completed");
    return { success: true };
  } catch (error) {
    console.error("Error unloading model:", error);

    // Even if there's an error, try to clear references
    model = null;
    processor = null;
    isModelLoaded = false;

    return { success: false, error: error.message };
  }
}

function notifyPopup(requestId, status, result) {
  // Send a message to any open popup
  chrome.runtime.sendMessage(
    {
      action: "requestUpdate",
      requestId: requestId,
      status: status,
      result: result,
    },
    () => {
      // Handle chrome.runtime.lastError to avoid uncaught errors
      // when popup isn't open
      if (chrome.runtime.lastError) {
        // This is expected if the popup is closed
        console.log(
          "Popup message not delivered:",
          chrome.runtime.lastError.message
        );
      }
    }
  );
}

// Process an image and generate explanation
async function explainImage(imageData, requestId) {
  console.log("Starting image explanation", requestId);

  if (requestId) {
    pendingRequests[requestId] = { status: "processing" };
    // Update storage to reflect processing status
    chrome.storage.local.set({
      pendingImageRequests: pendingRequests,
    });
  }

  // Make sure model is loaded
  if (!isModelLoaded) {
    console.log("Model not loaded, loading now...");
    const loadResult = await loadModel();
    if (!loadResult.success) {
      return { success: false, error: "Failed to load model" };
    }
    console.log("Model loading complete");
  }

  try {
    console.log("Processing image data...");
    // Create image from provided data
    let image;

    if (typeof imageData === "string") {
      // If image is from a URL
      image = await RawImage.read(imageData);
    } else {
      // If image is from a blob or uploaded file
      image = await RawImage.fromBlob(imageData);
    }

    console.log("Image created, resizing...");
    const resizedImage = await image.resize(256, 256);
    console.log("Image resized");

    // Prepare the conversation with a prompt
    const conversation = [
      {
        role: "user",
        content: [
          { type: "image" },
          {
            type: "text",
            text: "Explain this image.",
          },
        ],
      },
    ];

    console.log("Applying chat template...");
    const text = processor.apply_chat_template(conversation, {
      add_generation_prompt: true,
    });

    console.log("Creating processor inputs...");
    const inputs = await processor(text, resizedImage);
    console.log("Processor inputs created, running model generation...");

    // Generate the explanation
    const outputs = await model.generate({
      ...inputs,
      max_new_tokens: 1024,
    });
    console.log("Model generation complete, decoding outputs...");

    // Decode the output
    const decoded = processor.batch_decode(
      outputs.slice(null, [inputs.input_ids.dims.at(-1), null]),
      { skip_special_tokens: true }
    );

    console.log("Decoding complete");
    const result = { success: true, explanation: decoded[0].trim() };

    // If there was a request ID, store the result
    if (requestId) {
      pendingRequests[requestId] = {
        status: "completed",
        result: result,
      };
      chrome.storage.local.set({
        pendingImageRequests: pendingRequests,
      });
      notifyPopup(requestId, "completed", result);
    }

    return result;
  } catch (error) {
    console.error("Error in explainImage:", error);
    const errorResult = { success: false, error: error.message };

    // Store error result
    if (requestId) {
      pendingRequests[requestId] = {
        status: "error",
        result: errorResult,
      };
      chrome.storage.local.set({
        pendingImageRequests: pendingRequests,
      });
      notifyPopup(requestId, "error", errorResult);
    }

    return errorResult;
  }
}

// Listen for extension installation
chrome.runtime.onInstalled.addListener(() => {
  // Initialize settings if needed
  chrome.storage.sync.get({ masterEnabled: false }, (data) => {
    if (data.masterEnabled) {
      loadModel();
    }
  });
});

// Handle messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "checkModelStatus") {
    if (isModelLoaded) {
      sendResponse({ status: "loaded" });
    } else if (isLoadingModel) {
      sendResponse({ status: "loading" });
    } else {
      sendResponse({ status: "not_loaded" });
    }
    return true; // Keep the message channel open for async response
  } else if (message.action === "explainImage") {
    explainImage(message.imageData, message.requestId)
      .then((result) => {
        sendResponse(result);
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep the message channel open for async response
  } else if (message.action === "checkRequestStatus") {
    // Return status of a specific request
    const requestId = message.requestId;
    if (pendingRequests[requestId]) {
      sendResponse(pendingRequests[requestId]);
    } else {
      sendResponse({ status: "unknown" });
    }
    return true;
  } else if (message.action === "loadModel") {
    loadModel()
      .then((result) => {
        sendResponse(result);
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep the message channel open for async response
  } else if (message.action === "unloadModel") {
    unloadModel()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

// Listen for settings changes to load/unload model as needed
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.masterEnabled) {
    if (changes.masterEnabled.newValue && !isModelLoaded) {
      // Extension was enabled and model is not loaded
      loadModel();
    } else if (!changes.masterEnabled.newValue && isModelLoaded) {
      // Extension was disabled and model is loaded
      unloadModel();
    }
  }
});

chrome.runtime.onSuspend.addListener(() => {
  console.log("Service worker suspending, cleaning up resources");

  // Force cleanup without waiting for async completion
  isModelLoaded = false;
  if (model) model = null;
  if (processor) processor = null;
});
