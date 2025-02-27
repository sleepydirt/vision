document.addEventListener("DOMContentLoaded", function () {
  const masterToggle = document.getElementById("masterToggle");
  const statusText = document.getElementById("statusText");
  const statusBanner = document.getElementById("statusBanner");
  const dropArea = document.getElementById("dropArea");
  const dropMessage = document.getElementById("dropMessage");
  const previewContainer = document.getElementById("previewContainer");
  const imagePreview = document.getElementById("imagePreview");
  const explanationArea = document.getElementById("explanationArea");
  const explanationText = document.getElementById("explanationText");
  const loadingSpinner = document.getElementById("loadingSpinner");
  const clearBtn = document.getElementById("clearBtn");
  const uploadBtn = document.getElementById("uploadBtn");
  const fileInput = document.getElementById("fileInput");
  const modelStatusText = document.getElementById("modelStatusText");
  const modelSpinner = document.getElementById("modelSpinner");

  let modelLoadRetryCount = 0;
  const MAX_RETRIES = 3;
  let modelLoadRetryTimer = null;
  let currentImageData = null;
  let currentExplanation = null;
  let isProcessing = false;
  let currentRequestId = null;
  let statusCheckTimer = null;

  chrome.runtime.onMessage.addListener((message) => {
    if (
      message.action === "requestUpdate" &&
      message.requestId === currentRequestId
    ) {
      console.log("Received update from background:", message);
      if (message.status === "completed" || message.status === "error") {
        isProcessing = false;
        handleExplanationResponse(message.result);
      }
    }
  });

  function saveState() {
    const state = {
      imageData: currentImageData,
      explanation: currentExplanation,
      isProcessing: isProcessing,
      requestId: currentRequestId,
    };
    chrome.storage.local.set({ popupState: state });
  }

  function restoreState() {
    chrome.storage.local.get(["popupState", "pendingImageRequests"], (data) => {
      if (data.popupState) {
        const state = data.popupState;

        // First restore the visual state
        if (state.imageData) {
          // Restore image
          currentImageData = state.imageData;
          imagePreview.src = currentImageData;
          dropMessage.style.display = "none";
          previewContainer.style.display = "flex";
          explanationArea.style.display = "block";

          // Restore request ID
          currentRequestId = state.requestId;

          // If there was a pending request, check its status
          if (
            state.isProcessing &&
            currentRequestId &&
            data.pendingImageRequests
          ) {
            const request = data.pendingImageRequests[currentRequestId];

            if (request) {
              if (
                request.status === "completed" ||
                request.status === "error"
              ) {
                // Request completed while popup was closed
                handleExplanationResponse(request.result);
              } else if (request.status === "processing") {
                // Still processing, show spinner and check status periodically
                loadingSpinner.style.display = "flex";
                explanationText.textContent = "";
                checkRequestStatus();
              }
            } else {
              // Request not found, might have been lost
              loadingSpinner.style.display = "none";
              explanationText.textContent =
                "Request status unknown. Try again.";
            }
          } else if (state.explanation) {
            // Already has explanation
            loadingSpinner.style.display = "none";
            explanationText.textContent = state.explanation;
            currentExplanation = state.explanation;
          }
        }
      }
    });
  }

  function checkRequestStatus() {
    if (!currentRequestId || !isProcessing) {
      console.log("No request to check/Not processing");
      clearTimeout(statusCheckTimer);
      return;
    }
    console.log("Checking status for request:", currentRequestId);
    chrome.runtime.sendMessage(
      { action: "checkRequestStatus", requestId: currentRequestId },
      (response) => {
        console.log("Status check response:", response);
        if (response.status === "completed" || response.status === "error") {
          console.log("Request completed, updating UI");
          clearTimeout(statusCheckTimer);
          handleExplanationResponse(response.result);
        } else if (response.status === "processing") {
          console.log("Still processing, checking again in 1s");
          statusCheckTimer = setTimeout(checkRequestStatus, 1000);
        }
      }
    );
  }

  // Initialize UI based on saved state
  initializeUI();

  function initializeUI() {
    // Load saved settings
    chrome.storage.sync.get({ masterEnabled: false }, function (data) {
      // Set toggle state
      masterToggle.checked = data.masterEnabled;

      // Update UI based on master toggle
      updateMasterToggleUI(data.masterEnabled);

      // Check model status on popup open if extension is enabled
      if (data.masterEnabled) {
        checkAndUpdateModelStatus();
        // Restore popup state
        restoreState();
      }
    });
  }

  // Master toggle event listener
  masterToggle.addEventListener("change", function () {
    const isEnabled = masterToggle.checked;

    // Save master toggle state
    chrome.storage.sync.set({ masterEnabled: isEnabled }, function () {
      console.log("Extension is " + (isEnabled ? "enabled" : "disabled"));

      // Update UI based on master toggle
      updateMasterToggleUI(isEnabled);

      if (isEnabled) {
        // Load model if extension is enabled
        loadModelWithRetry();
      } else {
        // Reset UI if disabled and unload the model
        chrome.runtime.sendMessage({ action: "unloadModel" }, () => {
          resetUI();
          clearRetryTimer();
          clearTimeout(statusCheckTimer);
          modelStatusText.textContent = "Model: Not loaded";
          modelSpinner.style.display = "none";
        });
      }
    });
  });

  // Drag and drop functionality
  ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
    dropArea.addEventListener(eventName, preventDefaults, false);
  });

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  ["dragenter", "dragover"].forEach((eventName) => {
    dropArea.addEventListener(eventName, highlight, false);
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropArea.addEventListener(eventName, unhighlight, false);
  });

  function highlight() {
    if (
      !dropArea.classList.contains("disabled") &&
      !dropArea.classList.contains("loading-state")
    ) {
      dropArea.classList.add("active");
    }
  }

  function unhighlight() {
    dropArea.classList.remove("active");
  }

  // Handle file drop
  dropArea.addEventListener("drop", handleDrop, false);

  function handleDrop(e) {
    if (
      dropArea.classList.contains("disabled") ||
      dropArea.classList.contains("loading-state")
    ) {
      return;
    }

    const dt = e.dataTransfer;
    const files = dt.files;

    if (files.length) {
      handleFiles(files);
    }
  }

  // Handle file selection via button
  uploadBtn.addEventListener("click", () => {
    if (
      !dropArea.classList.contains("disabled") &&
      !dropArea.classList.contains("loading-state")
    ) {
      fileInput.click();
    }
  });

  fileInput.addEventListener("change", function () {
    if (this.files.length) {
      handleFiles(this.files);
    }
  });

  // Process the selected files
  function handleFiles(files) {
    if (!masterToggle.checked) {
      alert("Please enable the extension first.");
      return;
    }

    const file = files[0];

    // Check if the file is an image
    if (!file.type.match("image.*")) {
      alert("Please select an image file.");
      return;
    }

    // Display preview
    const reader = new FileReader();
    reader.onload = function (e) {
      imagePreview.src = e.target.result;
      dropMessage.style.display = "none";
      previewContainer.style.display = "flex";
      explanationArea.style.display = "block";
      loadingSpinner.style.display = "flex";
      explanationText.textContent = "";

      // Send image to background script for processing
      processImage(file);
    };
    reader.readAsDataURL(file);
  }

  // Clear the current image and explanation
  clearBtn.addEventListener("click", resetUI);

  function resetUI() {
    dropMessage.style.display = "flex";
    previewContainer.style.display = "none";
    explanationArea.style.display = "none";
    loadingSpinner.style.display = "none";
    explanationText.textContent = "";
    imagePreview.src = "";
    fileInput.value = "";

    clearTimeout(statusCheckTimer);
    // Clear saved state
    currentImageData = null;
    currentExplanation = null;
    currentRequestId = null;
    isProcessing = false;
    saveState();
  }

  // Process image with the model
  function processImage(imageFile) {
    // Check model status first
    chrome.runtime.sendMessage({ action: "checkModelStatus" }, (response) => {
      if (response.status === "loading") {
        explanationText.textContent = "Please wait, model is still loading...";
        return;
      }

      if (response.status === "not_loaded") {
        loadModelWithRetry(() => {
          // Once model is loaded, try processing again
          sendImageToBackground(imageFile);
        });
        return;
      }

      // Model is loaded, process the image
      sendImageToBackground(imageFile);
    });
  }

  // Send image to background script
  function sendImageToBackground(imageFile) {
    // Create a copy of the file for sending to background script
    const reader = new FileReader();
    reader.onload = function (e) {
      const base64data = e.target.result;
      currentImageData = base64data; // Save current image
      isProcessing = true;

      currentRequestId = Date.now().toString();

      saveState();
      console.log(
        "Sending image to background with requestId:",
        currentRequestId
      );
      chrome.runtime.sendMessage(
        {
          action: "explainImage",
          imageData: base64data,
          requestId: currentRequestId,
        },
        (response) => {
          console.log("Immediate response from background:", response);
          if (response) {
            handleExplanationResponse(response);
          } else {
            // Start polling for updates if we didn't get an immediate response
            console.log("No immediate response, starting status checking");
            statusCheckTimer = setTimeout(checkRequestStatus, 1000);
          }
        }
      );
    };
    reader.readAsDataURL(imageFile);
  }

  function handleExplanationResponse(response) {
    console.log("Handling explanation response:", response);
    loadingSpinner.style.display = "none";
    isProcessing = false;

    if (response.success) {
      explanationText.textContent = response.explanation;
      currentExplanation = response.explanation;
    } else {
      explanationText.textContent =
        "Error: " + (response.error || "Failed to process image");
      currentExplanation = explanationText.textContent;
    }
    saveState();
  }

  // Load the model with retry mechanism
  function loadModelWithRetry(callback) {
    modelLoadRetryCount = 0;
    clearRetryTimer();
    loadModelWithRetryImpl(callback);
  }

  function loadModelWithRetryImpl(callback) {
    setModelLoadingUI(true);

    chrome.runtime.sendMessage({ action: "loadModel" }, (response) => {
      chrome.runtime.sendMessage(
        { action: "checkModelStatus" },
        (statusResponse) => {
          if (statusResponse.status === "loaded") {
            // Model is actually loaded, override the response
            console.log("Model is already loaded despite response");
            modelStatusText.textContent =
              "Model: Loaded (Qwen2-VL-2B-Instruct)";
            modelSpinner.style.display = "none";
            setDropAreaEnabled(true);
            clearRetryTimer();
            modelLoadRetryCount = 0;
            if (callback) callback();
          } else if (response && response.success) {
            console.log("Model loaded successfully");
            modelStatusText.textContent =
              "Model: Loaded (Qwen2-VL-2B-Instruct)";
            modelSpinner.style.display = "none";
            setDropAreaEnabled(true);
            clearRetryTimer();
            modelLoadRetryCount = 0;

            if (callback) callback();
          } else {
            console.log(
              "Model failed to load, attempt: " + (modelLoadRetryCount + 1)
            );
            modelLoadRetryCount++;

            if (modelLoadRetryCount < MAX_RETRIES) {
              modelStatusText.textContent = `Model: Retrying (${modelLoadRetryCount}/${MAX_RETRIES})...`;

              // Retry after delay
              modelLoadRetryTimer = setTimeout(() => {
                loadModelWithRetryImpl(callback);
              }, 2000);
            } else {
              modelStatusText.textContent = "Model: Failed to load";
              modelSpinner.style.display = "none";
              setDropAreaEnabled(false);
              clearRetryTimer();
            }
          }
        }
      );
    });
  }

  // Clear retry timer
  function clearRetryTimer() {
    if (modelLoadRetryTimer) {
      clearTimeout(modelLoadRetryTimer);
      modelLoadRetryTimer = null;
    }
  }

  // Check model status and update UI accordingly
  function checkAndUpdateModelStatus() {
    setModelLoadingUI(true);

    chrome.runtime.sendMessage({ action: "checkModelStatus" }, (response) => {
      if (response.status === "loaded") {
        modelStatusText.textContent = "Model: Loaded (Qwen2-VL-2B-Instruct)";
        modelSpinner.style.display = "none";
        setDropAreaEnabled(true);
      } else if (response.status === "loading") {
        modelStatusText.textContent = "Model: Loading...";
        modelSpinner.style.display = "inline-block";
        setDropAreaEnabled(false);

        // Check again after a delay
        setTimeout(checkAndUpdateModelStatus, 1500);
      } else {
        // Not loaded, try loading it
        loadModelWithRetry();
      }
    });
  }

  // Set model loading UI state
  function setModelLoadingUI(isLoading) {
    if (isLoading) {
      modelSpinner.style.display = "inline-block";
      setDropAreaEnabled(false);
    } else {
      modelSpinner.style.display = "none";
    }
  }

  // Enable or disable drop area
  function setDropAreaEnabled(isEnabled) {
    if (isEnabled) {
      dropArea.classList.remove("disabled");
      dropArea.classList.remove("loading-state");
    } else {
      dropArea.classList.add("disabled");
      dropArea.classList.add("loading-state");
    }
  }

  // Function to update UI based on master toggle state
  function updateMasterToggleUI(isEnabled) {
    // Update status text and banner appearance
    statusText.textContent = isEnabled
      ? "Extension Enabled"
      : "Extension Disabled";

    if (isEnabled) {
      statusBanner.classList.add("status-enabled");
      statusBanner.classList.remove("status-disabled");
      checkAndUpdateModelStatus();
    } else {
      statusBanner.classList.add("status-disabled");
      statusBanner.classList.remove("status-enabled");
      dropArea.classList.add("disabled");
      resetUI();
      modelStatusText.textContent = "Model: Not loaded";
      modelSpinner.style.display = "none";
    }
  }
});
