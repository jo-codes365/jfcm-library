document.addEventListener("DOMContentLoaded", function () {
  var sidebar = document.getElementById("sidebar");
  var sidebarToggle = document.getElementById("sidebar-toggle");
  var sidebarBackdrop = document.getElementById("sidebar-backdrop");
  var mobileSidebarQuery = window.matchMedia("(max-width: 430px)");

  function setSidebarOpen(isOpen) {
    if (!sidebar || !sidebarToggle || !sidebarBackdrop) return;
    var shouldOpen = mobileSidebarQuery.matches && isOpen;
    sidebar.classList.toggle("is-open", shouldOpen);
    sidebarToggle.setAttribute("aria-expanded", String(shouldOpen));
    sidebarToggle.setAttribute("aria-label", shouldOpen ? "Close navigation" : "Open navigation");
    sidebarToggle.querySelector("i").className = shouldOpen ? "bi bi-x-lg" : "bi bi-list";
    sidebarBackdrop.hidden = !shouldOpen;
    document.body.classList.toggle("sidebar-open", shouldOpen);
  }

  if (sidebar && sidebarToggle && sidebarBackdrop) {
    sidebarToggle.addEventListener("click", function () {
      setSidebarOpen(sidebarToggle.getAttribute("aria-expanded") !== "true");
    });
    sidebarBackdrop.addEventListener("click", function () { setSidebarOpen(false); });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && sidebarToggle.getAttribute("aria-expanded") === "true") {
        setSidebarOpen(false);
        sidebarToggle.focus();
      }
    });
    mobileSidebarQuery.addEventListener("change", function () { setSidebarOpen(false); });
  }

  document.querySelectorAll("[data-password-toggle]").forEach(function (toggle) {
    var target = document.getElementById(toggle.dataset.passwordToggle);
    var icon = toggle.querySelector("i");
    if (!target || !icon) return;
    toggle.addEventListener("click", function () {
      var isVisible = target.type === "text";
      var visible = !isVisible;
      var form = target.closest("form");
      var pairedFields = [target];

      // A password/confirmation pair represents one visibility choice. Keep
      // both inputs and both controls synchronized; standalone fields remain
      // independent.
      if (form && (target.name === "password" || target.name === "confirm_password")) {
        var password = form.querySelector('[name="password"]');
        var confirmation = form.querySelector('[name="confirm_password"]');
        if (password && confirmation) pairedFields = [password, confirmation];
      }
      pairedFields.forEach(function (field) {
        field.type = visible ? "text" : "password";
      });
      document.querySelectorAll("[data-password-toggle]").forEach(function (pairedToggle) {
        var pairedTarget = document.getElementById(pairedToggle.dataset.passwordToggle);
        if (pairedFields.indexOf(pairedTarget) === -1) return;
        var pairedIcon = pairedToggle.querySelector("i");
        if (pairedIcon) pairedIcon.className = visible ? "bi bi-eye-slash" : "bi bi-eye";
        pairedToggle.setAttribute("aria-label", visible ? "Hide password" : "Show password");
        pairedToggle.setAttribute("aria-pressed", String(visible));
      });
    });
  });

  function dismissToast(toast) {
    if (!toast || toast.classList.contains("toast-exit")) return;
    toast.classList.add("toast-exit");
    window.setTimeout(function () { toast.remove(); }, 320);
  }
  document.querySelectorAll(".toast").forEach(function (toast) {
    window.setTimeout(function () { dismissToast(toast); }, 5000);
  });

  function showToast(message, category) {
    var toastStack = document.querySelector(".toast-stack");
    if (!toastStack) {
      toastStack = document.createElement("div");
      toastStack.className = "toast-stack";
      toastStack.setAttribute("aria-live", "polite");
      document.body.appendChild(toastStack);
    }
    toastStack.querySelectorAll(".toast").forEach(function (toast) {
      dismissToast(toast);
    });
    var toast = document.createElement("div");
    toast.className = "toast toast-" + category;
    toast.textContent = message;
    toastStack.appendChild(toast);
    window.setTimeout(function () { dismissToast(toast); }, 5000);
  }

  function offlineHash(value) {
    var hash = 5381;
    for (var index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
    return (hash >>> 0).toString(36);
  }

  var offlineScopeMeta = document.querySelector("meta[name='offline-cache-scope']");
  var offlineScopeValue = offlineScopeMeta ? offlineScopeMeta.content : "public";
  var offlineScopeSegment = offlineScopeValue.indexOf("private:") === 0 ? "private-" + offlineHash(offlineScopeValue) : "public";
  var offlineCachePrefix = "jfcm-offline-item-v2-" + offlineScopeSegment + "-";
  try {
    window.localStorage.setItem("jfcmOfflineScopeSegment", offlineScopeSegment);
  } catch (_error) {}

  function sendOfflineScope(worker) {
    if (!worker) return Promise.resolve();
    if (!("MessageChannel" in window)) {
      worker.postMessage({ type: "SET_OFFLINE_SCOPE", scope: offlineScopeSegment });
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      var channel = new MessageChannel();
      var finished = false;
      var timeout = window.setTimeout(function () {
        if (!finished) resolve();
      }, 2000);
      channel.port1.onmessage = function () {
        finished = true;
        window.clearTimeout(timeout);
        resolve();
      };
      try {
        worker.postMessage({ type: "SET_OFFLINE_SCOPE", scope: offlineScopeSegment }, [channel.port2]);
      } catch (_error) {
        window.clearTimeout(timeout);
        resolve();
      }
    });
  }

  var offlineServiceWorkerReady = null;
  var offlineServiceWorkerError = null;
  if ("serviceWorker" in navigator && "caches" in window) {
    offlineServiceWorkerReady = navigator.serviceWorker.register("/service-worker.js", {
      scope: "/",
      updateViaCache: "none"
    }).then(function (registration) {
      var expectedScope = new URL("/", window.location.origin).href;
      if (registration.scope !== expectedScope) throw new Error("The offline worker does not control the whole application");
      return navigator.serviceWorker.ready;
    }).then(async function (registration) {
      var cacheNames = await caches.keys();
      var currentPrivatePrefix = offlineScopeSegment.indexOf("private-") === 0 ? "jfcm-offline-item-v2-" + offlineScopeSegment + "-" : "";
      await Promise.all(cacheNames.filter(function (name) {
        return name.indexOf("jfcm-offline-item-v2-private-") === 0 && (!currentPrivatePrefix || name.indexOf(currentPrivatePrefix) !== 0);
      }).map(function (name) { return caches.delete(name); }));
      var worker = navigator.serviceWorker.controller || registration.active || registration.waiting;
      await sendOfflineScope(worker);
      return registration;
    }).catch(function (error) {
      offlineServiceWorkerError = error;
      return null;
    });
  }

  function offlineCacheName(manifestUrl) {
    var value = new URL(manifestUrl, window.location.href).href;
    return offlineCachePrefix + offlineHash(value);
  }

  async function isAccessibleOffline(manifestUrl) {
    if (!manifestUrl || !("caches" in window)) return false;
    var cacheNames = await caches.keys();
    return cacheNames.includes(offlineCacheName(manifestUrl));
  }

  function renderOfflineAction(button, isOffline) {
    if (!button) return;
    var label = isOffline ? "Unsave Offline" : "Save Offline";
    var iconClass = isOffline ? "bi bi-cloud-slash" : "bi bi-cloud-arrow-down";
    var icon = button.querySelector("i");
    var textLabel = button.querySelector("span");
    if (icon) {
      icon.className = iconClass;
      icon.removeAttribute("role");
      icon.setAttribute("aria-hidden", "true");
    }
    if (textLabel) textLabel.textContent = label;
    button.dataset.offlineCached = String(isOffline);
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
  }

  function setOfflineActionLoading(button, isLoading, wasOffline) {
    if (!button) return;
    var icon = button.querySelector("i");
    var textLabel = button.querySelector("span");
    if (!isLoading) {
      button.disabled = false;
      delete button.dataset.offlineLoading;
      return;
    }
    var label = wasOffline ? "Removing Offline..." : "Saving Offline...";
    button.disabled = true;
    button.dataset.offlineLoading = "true";
    if (icon) {
      icon.className = "spinner-border spinner-border-sm";
      icon.setAttribute("role", "status");
      icon.setAttribute("aria-hidden", "true");
    }
    if (textLabel) textLabel.textContent = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
  }

  async function syncOfflineAction(button) {
    if (!button || !button.dataset.offlineUrl || button.dataset.offlineLoading === "true") return;
    renderOfflineAction(button, await isAccessibleOffline(button.dataset.offlineUrl));
  }

  async function cacheItemOffline(manifestUrl) {
    if (!offlineServiceWorkerReady) throw new Error("Offline access is unavailable in this browser");
    var registration = await offlineServiceWorkerReady;
    if (!registration) throw offlineServiceWorkerError || new Error("Offline storage is blocked by the browser's privacy settings");
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    var absoluteManifestUrl = new URL(manifestUrl, window.location.href).href;
    var manifestResponse = await fetch(absoluteManifestUrl, { credentials: "same-origin", cache: "no-store" });
    if (!manifestResponse.ok) throw new Error("Offline manifest request failed");
    var manifest = await manifestResponse.clone().json();
    if (!manifest.ok || !Array.isArray(manifest.urls)) throw new Error("Offline manifest is invalid");
    var cacheName = offlineCacheName(absoluteManifestUrl);
    await caches.delete(cacheName);
    var cache = await caches.open(cacheName);
    try {
      for (var url of manifest.urls) {
        var absoluteUrl = new URL(url, window.location.href).href;
        var request = new Request(absoluteUrl, { method: "GET", credentials: "same-origin" });
        var response = await fetch(request);
        if (!response.ok) throw new Error("A required offline resource could not be downloaded");
        await cache.put(request, response.clone());
      }
      await cache.put(absoluteManifestUrl, manifestResponse);
      return manifest;
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
  }

  function removeItemOffline(manifestUrl) {
    return caches.delete(offlineCacheName(manifestUrl));
  }

  async function refreshOfflineActions(manifestUrl) {
    var absoluteUrl = new URL(manifestUrl, window.location.href).href;
    var buttons = Array.from(document.querySelectorAll("[data-offline-action='true'][data-offline-url]"));
    await Promise.all(buttons.filter(function (button) {
      return new URL(button.dataset.offlineUrl, window.location.href).href === absoluteUrl;
    }).map(syncOfflineAction));
  }

  document.addEventListener("click", async function (event) {
    var button = event.target.closest("[data-offline-action='true']");
    if (!button || !button.dataset.offlineUrl) return;
    event.preventDefault();
    event.stopPropagation();
    var wasOffline = button.dataset.offlineCached === "true";
    setOfflineActionLoading(button, true, wasOffline);
    try {
      wasOffline = await isAccessibleOffline(button.dataset.offlineUrl);
      if (wasOffline) {
        await removeItemOffline(button.dataset.offlineUrl);
        showToast("Offline access removed.", "success");
      } else {
        var manifest = await cacheItemOffline(button.dataset.offlineUrl);
        showToast((manifest.file_count || 0) + " file" + (manifest.file_count === 1 ? "" : "s") + " available offline.", "success");
      }
      setOfflineActionLoading(button, false, wasOffline);
      await refreshOfflineActions(button.dataset.offlineUrl);
      if (typeof syncBulkOfflineAction === "function") syncBulkOfflineAction();
    } catch (error) {
      setOfflineActionLoading(button, false, wasOffline);
      renderOfflineAction(button, wasOffline);
      showToast(error.message || "Offline access could not be updated.", "error");
    }
  });

  document.querySelectorAll("[data-offline-action='true'][data-offline-url]").forEach(syncOfflineAction);
  var customDialogModal = document.getElementById("custom-dialog-modal");
  var customDialogTitle = document.getElementById("custom-dialog-title");
  var customDialogMessage = document.getElementById("custom-dialog-message");
  var customDialogCancel = document.getElementById("custom-dialog-cancel");
  var customDialogAction = document.getElementById("custom-dialog-action");
  var customDialogCallback = null;
  function closeCustomDialog() {
    if (customDialogModal) customDialogModal.hidden = true;
    customDialogCallback = null;
  }
  function showCustomAlert(message, title) {
    if (!customDialogModal) return;
    customDialogTitle.textContent = title || "Notice";
    customDialogMessage.textContent = message;
    customDialogCancel.hidden = true;
    customDialogAction.textContent = "OK";
    customDialogAction.className = "button primary";
    customDialogCallback = null;
    customDialogModal.hidden = false;
    customDialogAction.focus();
  }
  function showCustomConfirm(message, actionLabel, isDanger, onConfirm) {
    if (!customDialogModal) return;
    customDialogTitle.textContent = "Confirm action";
    customDialogMessage.textContent = message;
    customDialogCancel.hidden = false;
    customDialogAction.textContent = actionLabel;
    customDialogAction.className = "button " + (isDanger ? "danger" : "primary");
    customDialogCallback = onConfirm;
    customDialogModal.hidden = false;
    customDialogAction.focus();
  }
  if (customDialogCancel) customDialogCancel.addEventListener("click", closeCustomDialog);
  if (customDialogAction) customDialogAction.addEventListener("click", function () {
    var callback = customDialogCallback;
    closeCustomDialog();
    if (callback) callback();
  });
  if (customDialogModal) customDialogModal.addEventListener("click", function (event) {
    if (event.target === customDialogModal) closeCustomDialog();
  });

  var closePreview = document.getElementById("close-preview");
  if (closePreview) {
    closePreview.addEventListener("click", function (event) {
      event.preventDefault();
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.location.href = closePreview.href;
      }
    });
  }

  var logoutLink = document.getElementById("logout-link");
  var logoutModal = document.getElementById("logout-modal");
  if (logoutModal) logoutModal.style.zIndex = "35";
  var cancelLogout = document.getElementById("cancel-logout");
  var confirmLogout = document.getElementById("confirm-logout");
  if (logoutLink && logoutModal) {
    logoutLink.addEventListener("click", function (event) {
      event.preventDefault();
      logoutModal.hidden = false;
      if (cancelLogout) cancelLogout.focus();
    });
    if (cancelLogout) {
      cancelLogout.addEventListener("click", function () { logoutModal.hidden = true; });
    }
    logoutModal.addEventListener("click", function (event) {
      if (event.target === logoutModal) logoutModal.hidden = true;
    });
    if (confirmLogout) {
      confirmLogout.addEventListener("click", async function (event) {
        event.preventDefault();
        var destination = confirmLogout.href;
        try {
          if ("caches" in window) {
            var names = await caches.keys();
            await Promise.all(names.filter(function (name) {
              return name.indexOf("jfcm-offline-item-v2-private-") === 0;
            }).map(function (name) { return caches.delete(name); }));
          }
          window.localStorage.setItem("jfcmOfflineScopeSegment", "public");
          var worker = navigator.serviceWorker && navigator.serviceWorker.controller;
          if (worker) worker.postMessage({ type: "SET_OFFLINE_SCOPE", scope: "public" });
        } catch (_error) {}
        window.location.href = destination;
      });
    }
  }

  var eventsToggle = document.getElementById("events-toggle");
  var eventsSubmenu = document.getElementById("events-submenu");
  if (eventsToggle && eventsSubmenu) {
    eventsToggle.addEventListener("click", function () {
      eventsSubmenu.hidden = !eventsSubmenu.hidden;
      eventsToggle.setAttribute("aria-expanded", String(!eventsSubmenu.hidden));
    });
  }

  var fileInput = document.getElementById("file-input");
  var folderInputPicker = document.getElementById("folder-input");
  var dropZone = document.getElementById("drop-zone");
  var uploadForm = document.getElementById("upload-form");
  var uploadTransferPanel = document.getElementById("upload-transfer-panel");
  var uploadTransferTitle = document.getElementById("upload-transfer-title");
  var uploadTransferToggle = document.getElementById("upload-transfer-toggle");
  var uploadTransferClose = document.getElementById("upload-transfer-close");
  var uploadTransferStatus = document.getElementById("upload-transfer-status");
  var uploadTransferList = document.getElementById("upload-transfer-list");
  var uploadTransferCancel = document.getElementById("upload-transfer-cancel");
  var activeUploadRequest = null;
  var uploadIsRunning = false;
  var uploadWasCancelled = false;
  var maxSizeMb = uploadForm ? Number(uploadForm.dataset.maxSizeMb) : 50;
  var maxSize = maxSizeMb * 1024 * 1024;
  function currentWorkspaceUrl() {
    var workspaceUrl = new URL(window.location.href);
    ["search", "type", "date", "sort", "direction"].forEach(function (key) { workspaceUrl.searchParams.delete(key); });
    if (typeof searchInput !== "undefined" && searchInput && searchInput.value) workspaceUrl.searchParams.set("search", searchInput.value);
    if (typeof filterState !== "undefined" && filterState.type !== "all") workspaceUrl.searchParams.set("type", filterState.type);
    if (typeof filterState !== "undefined" && filterState.date !== "all") workspaceUrl.searchParams.set("date", filterState.date);
    if (typeof activeSortField !== "undefined" && activeSortField !== "date") workspaceUrl.searchParams.set("sort", activeSortField);
    if (typeof activeSortDirection !== "undefined" && activeSortDirection !== "desc") workspaceUrl.searchParams.set("direction", activeSortDirection);
    return workspaceUrl;
  }
  function syncWorkspaceState() {
    var workspaceUrl = currentWorkspaceUrl();
    window.history.replaceState(null, "", workspaceUrl.toString());
  }
  function addWorkspaceReturnTarget(form) {
    if (!form) return;
    var returnTarget = form.querySelector("input[name='return_to']");
    if (!returnTarget) {
      returnTarget = document.createElement("input");
      returnTarget.type = "hidden";
      returnTarget.name = "return_to";
      form.appendChild(returnTarget);
    }
    returnTarget.value = currentWorkspaceUrl().toString();
  }
  document.querySelectorAll("form[action='/folders']").forEach(function (form) {
    form.addEventListener("submit", function () { addWorkspaceReturnTarget(form); });
  });
  document.querySelectorAll("form[action='/events']").forEach(function (form) {
    form.addEventListener("submit", function () { addWorkspaceReturnTarget(form); });
  });

  function formatLongDate(isoDate) {
    if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return "";
    var parts = isoDate.split("-").map(Number);
    var localDate = new Date(parts[0], parts[1] - 1, parts[2]);
    if (Number.isNaN(localDate.getTime())) return "";
    return localDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }
  function initCustomEventDateInput(form) {
    if (!form) return;
    var dateInput = form.querySelector(".event-date-native-input");
    var dateDisplay = form.querySelector(".event-date-formatted-display");
    var dateField = form.querySelector(".event-date-field");
    if (!dateInput || !dateDisplay || !dateField) return;
    function syncDisplayFromValue() {
      var formatted = formatLongDate(dateInput.value);
      dateDisplay.textContent = formatted || "Select a date";
      dateField.classList.toggle("has-value", Boolean(formatted));
    }
    syncDisplayFromValue();
    dateInput.addEventListener("input", syncDisplayFromValue);
    dateInput.addEventListener("change", syncDisplayFromValue);
    dateInput.addEventListener("blur", syncDisplayFromValue);
  }
  document.querySelectorAll("form[action='/events']").forEach(initCustomEventDateInput);

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function validateFile(file) {
    if (!file) { return { valid: false, message: "Select a file to upload." }; }
    if (file.size === 0) { return { valid: false, message: "Empty files cannot be uploaded." }; }
    if (file.size > maxSize) { return { valid: false, message: "Files must be " + maxSizeMb + " MB or smaller." }; }
    return { valid: true, message: "" };
  }

  function uploadIconUrl(file) {
    if (!uploadTransferPanel) return "";
    var extension = file.name.indexOf(".") === -1 ? "" : file.name.split(".").pop().toLowerCase();
    var mimeType = (file.type || "").toLowerCase();
    var iconKey = "file";
    if (mimeType.indexOf("image/") === 0 || ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff"].includes(extension)) iconKey = "image";
    else if (mimeType === "application/pdf" || extension === "pdf") iconKey = "pdf";
    else if (["doc", "docx", "odt", "rtf", "txt", "md"].includes(extension)) iconKey = "document";
    else if (["xls", "xlsx", "ods", "csv", "tsv"].includes(extension)) iconKey = "spreadsheet";
    else if (["ppt", "pptx", "pps", "ppsx", "odp"].includes(extension)) iconKey = "powerpoint";
    else if (mimeType.indexOf("video/") === 0 || ["mp4", "webm", "mov", "avi", "mkv", "m4v"].includes(extension)) iconKey = "video";
    else if (mimeType.indexOf("audio/") === 0 || ["mp3", "wav", "ogg", "m4a", "aac", "flac"].includes(extension)) iconKey = "audio";
    else if (["zip", "rar", "7z", "tar", "gz", "tgz"].includes(extension)) iconKey = "zip";
    return uploadTransferPanel.dataset["icon" + iconKey.charAt(0).toUpperCase() + iconKey.slice(1)] || uploadTransferPanel.dataset.iconFile;
  }

  function setTransferItemState(item, status, progress, message) {
    item.status = status;
    item.progress = progress;
    item.element.classList.toggle("is-success", status === "success");
    item.element.classList.toggle("is-error", status === "error");
    item.element.classList.toggle("is-cancelled", status === "cancelled");
    item.progressValue.style.width = progress + "%";
    item.progressTrack.setAttribute("aria-valuenow", String(progress));
    item.statusElement.textContent = status === "success" ? "Done" : status === "error" ? "Error" : status === "cancelled" ? "Cancelled" : progress + "%";
    item.element.title = message || item.file.name;
  }

  function createTransferItem(file) {
    var item = { file: file, status: "pending", progress: 0 };
    var row = document.createElement("div");
    row.className = "upload-transfer-item";
    var icon = document.createElement("img");
    icon.className = "upload-transfer-icon";
    icon.src = uploadIconUrl(file);
    icon.alt = "";
    var info = document.createElement("div");
    info.className = "upload-transfer-file-info";
    var name = document.createElement("span");
    name.className = "upload-transfer-filename";
    name.textContent = file.name || "File";
    name.title = file.name || "File";
    var progressTrack = document.createElement("div");
    progressTrack.className = "upload-transfer-progress";
    progressTrack.setAttribute("role", "progressbar");
    progressTrack.setAttribute("aria-label", "Upload progress for " + (file.name || "file"));
    progressTrack.setAttribute("aria-valuemin", "0");
    progressTrack.setAttribute("aria-valuemax", "100");
    progressTrack.setAttribute("aria-valuenow", "0");
    var progressValue = document.createElement("div");
    progressValue.className = "upload-transfer-progress-value";
    progressTrack.appendChild(progressValue);
    info.appendChild(name);
    info.appendChild(progressTrack);
    var status = document.createElement("span");
    status.className = "upload-transfer-item-status";
    status.textContent = "0%";
    row.appendChild(icon);
    row.appendChild(info);
    row.appendChild(status);
    item.element = row;
    item.progressTrack = progressTrack;
    item.progressValue = progressValue;
    item.statusElement = status;
    return item;
  }

  function uploadContext(destinationOverride) {
    var context = { fields: {}, csrfToken: "" };
    ["csrf_token", "folder_id", "event_id", "share_context_kind", "share_context_token"].forEach(function (name) {
      var input = uploadForm.querySelector('input[name="' + name + '"]');
      if (input && input.value) context.fields[name] = input.value;
    });
    if (destinationOverride !== undefined && destinationOverride !== null) context.fields.folder_id = String(destinationOverride);
    context.csrfToken = context.fields.csrf_token || "";
    context.returnTo = currentWorkspaceUrl().toString();
    return context;
  }

  function uploadTransferItem(item, context) {
    return new Promise(function (resolve) {
      var payload = new FormData();
      payload.append("file", item.file, item.file.name);
      payload.append("folder_path", item.file.webkitRelativePath || "");
      Object.keys(context.fields).forEach(function (name) { payload.append(name, context.fields[name]); });
      payload.append("return_to", context.returnTo);
      var request = new XMLHttpRequest();
      var settled = false;
      activeUploadRequest = request;
      function finish(success, message, cancelled) {
        if (settled) return;
        settled = true;
        if (activeUploadRequest === request) activeUploadRequest = null;
        setTransferItemState(item, cancelled ? "cancelled" : success ? "success" : "error", success ? 100 : item.progress, message);
        resolve(success);
      }
      request.open("POST", uploadForm.action, true);
      request.setRequestHeader("X-Requested-With", "XMLHttpRequest");
      if (context.csrfToken) request.setRequestHeader("X-CSRFToken", context.csrfToken);
      request.upload.addEventListener("progress", function (event) {
        if (!event.lengthComputable) return;
        setTransferItemState(item, "uploading", Math.min(99, Math.round(event.loaded / event.total * 100)));
      });
      request.addEventListener("load", function () {
        var response = null;
        try { response = JSON.parse(request.responseText); } catch (_error) {}
        var result = response && response.results && response.results[0];
        var success = request.status >= 200 && request.status < 300 && result && result.status === "success";
        finish(success, result && result.message ? result.message : success ? "File uploaded successfully." : "Upload failed. Please try again.", false);
      });
      request.addEventListener("error", function () { finish(false, "Upload failed. Please try again.", false); });
      request.addEventListener("abort", function () { finish(false, "Upload cancelled.", true); });
      request.send(payload);
    });
  }

  async function startUploads(files, destinationOverride) {
    if (!uploadForm || !uploadTransferPanel || !uploadTransferList || !files.length) return;
    if (uploadIsRunning) {
      uploadTransferPanel.hidden = false;
      showToast("An upload is already in progress.", "error");
      return;
    }
    uploadIsRunning = true;
    uploadWasCancelled = false;
    uploadTransferPanel.hidden = false;
    uploadTransferPanel.setAttribute("aria-busy", "true");
    uploadTransferPanel.classList.remove("is-collapsed");
    uploadTransferToggle.setAttribute("aria-expanded", "true");
    uploadTransferToggle.setAttribute("aria-label", "Collapse uploads");
    uploadTransferToggle.setAttribute("title", "Collapse");
    uploadTransferToggle.querySelector("i").className = "bi bi-chevron-down";
    uploadTransferTitle.textContent = "Uploading " + files.length + " item" + (files.length === 1 ? "" : "s");
    uploadTransferStatus.textContent = "Starting upload...";
    uploadTransferCancel.hidden = false;
    uploadTransferCancel.disabled = false;
    uploadTransferCancel.parentElement.hidden = false;
    uploadTransferList.replaceChildren();
    var items = files.map(function (file) {
      var item = createTransferItem(file);
      uploadTransferList.appendChild(item.element);
      var validation = validateFile(file);
      item.valid = validation.valid;
      if (!validation.valid) setTransferItemState(item, "error", 100, validation.message);
      return item;
    });
    var context = uploadContext(destinationOverride);
    if (fileInput) fileInput.value = "";
    if (folderInputPicker) folderInputPicker.value = "";
    var validItems = items.filter(function (item) { return item.valid; });
    await new Promise(function (resolve) { window.requestAnimationFrame(resolve); });
    for (var index = 0; index < validItems.length; index += 1) {
      if (uploadWasCancelled) break;
      uploadTransferStatus.textContent = "Uploading...";
      var uploaded = await uploadTransferItem(validItems[index], context);
      if (uploaded) refreshWorkspaceContents();
    }
    if (uploadWasCancelled) {
      validItems.forEach(function (item) {
        if (item.status === "pending") setTransferItemState(item, "cancelled", 0, "Upload cancelled.");
      });
      uploadTransferStatus.textContent = "Upload cancelled";
    } else {
      uploadTransferStatus.textContent = "Upload complete";
    }
    uploadIsRunning = false;
    activeUploadRequest = null;
    uploadTransferCancel.hidden = true;
    uploadTransferCancel.parentElement.hidden = true;
    uploadTransferPanel.setAttribute("aria-busy", "false");
  }

  if (uploadTransferToggle && uploadTransferPanel) uploadTransferToggle.addEventListener("click", function () {
    var collapsed = uploadTransferPanel.classList.toggle("is-collapsed");
    uploadTransferToggle.setAttribute("aria-expanded", String(!collapsed));
    uploadTransferToggle.setAttribute("aria-label", collapsed ? "Expand uploads" : "Collapse uploads");
    uploadTransferToggle.setAttribute("title", collapsed ? "Expand" : "Collapse");
    uploadTransferToggle.querySelector("i").className = "bi " + (collapsed ? "bi-chevron-up" : "bi-chevron-down");
  });
  if (uploadTransferClose && uploadTransferPanel) uploadTransferClose.addEventListener("click", function () {
    uploadTransferPanel.hidden = true;
  });
  if (uploadTransferCancel) uploadTransferCancel.addEventListener("click", function () {
    if (!uploadIsRunning) return;
    uploadWasCancelled = true;
    uploadTransferStatus.textContent = "Cancelling...";
    uploadTransferCancel.disabled = true;
    if (activeUploadRequest) activeUploadRequest.abort();
  });

  if (fileInput && uploadForm) {
    uploadForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var selectedFiles = Array.from(fileInput.files || []);
      if (!selectedFiles.length) {
        showCustomAlert("Select a file to upload.", "Upload files");
        return;
      }
      startUploads(selectedFiles);
    });
    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files.length) uploadForm.requestSubmit();
    });
    if (folderInputPicker) folderInputPicker.addEventListener("change", function () {
      if (folderInputPicker.files && folderInputPicker.files.length) startUploads(Array.from(folderInputPicker.files));
    });
  }

  var modal = document.getElementById("delete-modal");
  var deleteForm = document.getElementById("delete-form");
  function openDeleteModal(fileId, fileName) {
    if (!deleteForm || !modal) return;
    deleteForm.action = "/delete/" + fileId;
    document.getElementById("delete-file-name").textContent = fileName;
    modal.hidden = false;
  }
  function closeModal() { if (modal) modal.hidden = true; }
  document.querySelectorAll(".delete-trigger").forEach(function (button) {
    button.addEventListener("click", function () { openDeleteModal(button.dataset.fileId, button.dataset.fileName); });
  });
  var closeButton = document.getElementById("close-modal");
  var cancelButton = document.getElementById("cancel-delete");
  if (closeButton) closeButton.addEventListener("click", closeModal);
  if (cancelButton) cancelButton.addEventListener("click", closeModal);
  if (modal) modal.addEventListener("click", function (event) { if (event.target === modal) closeModal(); });

  var previewMoreButton = document.getElementById("preview-more-button");
  var previewMoreMenu = document.getElementById("preview-more-menu");
  var previewStarButton = document.getElementById("preview-star-button");
  var previewCopyAction = document.getElementById("preview-copy-action");
  var previewRenameButton = document.getElementById("preview-rename-button");
  var previewMoveButton = document.getElementById("preview-move-button");
  var previewMoveDestination = document.getElementById("preview-move-destination");
  var previewPropertiesButton = document.getElementById("preview-properties-button");
  if (previewMoreButton && previewMoreMenu) {
    previewMoreButton.addEventListener("click", function (event) {
      event.stopPropagation();
      previewMoreMenu.hidden = !previewMoreMenu.hidden;
      previewMoreButton.setAttribute("aria-expanded", String(!previewMoreMenu.hidden));
    });
    document.addEventListener("click", function (event) {
      if (!previewMoreMenu.hidden && !previewMoreMenu.contains(event.target) && !previewMoreButton.contains(event.target)) {
        previewMoreMenu.hidden = true;
        previewMoreButton.setAttribute("aria-expanded", "false");
      }
    });
  }
  function closePreviewMoreMenu() {
    if (previewMoreMenu) previewMoreMenu.hidden = true;
    if (previewMoreButton) previewMoreButton.setAttribute("aria-expanded", "false");
  }
  function togglePreviewModal(id, visible) {
    var modalElement = document.getElementById(id);
    if (modalElement) modalElement.hidden = !visible;
    closePreviewMoreMenu();
  }
  if (previewRenameButton) previewRenameButton.addEventListener("click", function () {
    togglePreviewModal("preview-rename-modal", true);
    var input = document.querySelector("#preview-rename-modal input[name='name']");
    if (input) { input.focus(); input.select(); }
  });
  if (previewMoveButton) previewMoveButton.addEventListener("click", function () {
    togglePreviewModal("preview-move-modal", true);
    if (previewMoveDestination) previewMoveDestination.focus();
  });
  if (previewPropertiesButton) previewPropertiesButton.addEventListener("click", function () {
    togglePreviewModal("preview-properties-modal", true);
  });
  if (previewCopyAction) previewCopyAction.addEventListener("click", function () {
    navigator.clipboard.writeText(previewCopyAction.dataset.copyUrl).then(function () {
      showToast("Link copied.", "success");
      closePreviewMoreMenu();
    }).catch(function () {
      showToast("Copy failed. Please try again.", "error");
    });
  });
  document.getElementById("cancel-preview-rename")?.addEventListener("click", function () { togglePreviewModal("preview-rename-modal", false); });
  document.getElementById("cancel-preview-move")?.addEventListener("click", function () { togglePreviewModal("preview-move-modal", false); });
  document.getElementById("close-preview-properties")?.addEventListener("click", function () { togglePreviewModal("preview-properties-modal", false); });
  ["preview-rename-modal", "preview-move-modal", "preview-properties-modal"].forEach(function (id) {
    var modalElement = document.getElementById(id);
    if (modalElement) modalElement.addEventListener("click", function (event) {
      if (event.target === modalElement) togglePreviewModal(id, false);
    });
  });
  if (previewStarButton) previewStarButton.addEventListener("click", function () {
    var csrfInput = document.querySelector("#preview-move-modal input[name='csrf_token']");
    var payload = new FormData();
    payload.append("csrf_token", csrfInput ? csrfInput.value : "");
    payload.append("items", "file:" + previewStarButton.dataset.fileId);
    var isCurrentlyStarred = previewStarButton.dataset.starred === "true";
    payload.append("starred", String(!isCurrentlyStarred));
    fetch(previewStarButton.dataset.starUrl, {
      method: "POST",
      body: payload,
      headers: { "X-Requested-With": "XMLHttpRequest" }
    }).then(function (response) {
      if (!response.ok) throw new Error("Star update failed");
      return response.json();
    }).then(function () {
      showToast(isCurrentlyStarred ? "Removed from Starred." : "Added to Starred.", "success");
      previewStarButton.innerHTML = isCurrentlyStarred ? '<i class="bi bi-star"></i> Star' : '<i class="bi bi-star-fill"></i> Unstar';
      previewStarButton.dataset.starred = String(!isCurrentlyStarred);
      closePreviewMoreMenu();
    }).catch(function () { showToast("The star update could not be completed.", "error"); });
  });

  var uploadButton = document.getElementById("upload-button");
  var uploadMenuAction = document.getElementById("upload-menu-action");
  var uploadFolderMenuAction = document.getElementById("upload-folder-menu-action");
  var newMenuButton = document.getElementById("new-menu-button");
  var newMenu = document.getElementById("new-menu");
  function openFilePicker() {
    if (!fileInput) return;
    if (newMenu) newMenu.hidden = true;
    if (newMenuButton) newMenuButton.setAttribute("aria-expanded", "false");
    fileInput.click();
  }
  if (uploadButton) uploadButton.addEventListener("click", openFilePicker);
  if (uploadMenuAction) uploadMenuAction.addEventListener("click", openFilePicker);
  if (uploadFolderMenuAction && folderInputPicker) {
    uploadFolderMenuAction.addEventListener("click", function () {
      if (newMenu) newMenu.hidden = true;
      if (newMenuButton) newMenuButton.setAttribute("aria-expanded", "false");
      folderInputPicker.click();
    });
  }
  if (newMenuButton && newMenu) {
    newMenuButton.addEventListener("click", function () {
      newMenu.hidden = !newMenu.hidden;
      newMenuButton.setAttribute("aria-expanded", String(!newMenu.hidden));
    });
    document.addEventListener("click", function (event) {
      if (!newMenu.hidden && !newMenu.contains(event.target) && !newMenuButton.contains(event.target)) {
        newMenu.hidden = true;
        newMenuButton.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !newMenu.hidden) {
        newMenu.hidden = true;
        newMenuButton.setAttribute("aria-expanded", "false");
        newMenuButton.focus();
      }
    });
  }

  var workspaceContent = document.querySelector(".workspace-content");
  var folderDropRows = Array.from(document.querySelectorAll(".file-workspace [data-folder-id]"));
  function setDropTarget(target) {
    if (workspaceContent) workspaceContent.classList.toggle("drag-over", target === workspaceContent);
    folderDropRows.forEach(function (row) {
      row.classList.toggle("drag-over", row === target);
    });
  }
  function uploadDroppedFiles(files, folderId) {
    if (!uploadForm || !files.length) return;
    startUploads(files, folderId || "");
  }
  if (workspaceContent && workspaceContent.dataset.dropEnabled === "true") {
    workspaceContent.addEventListener("dragover", function (event) {
      if (!event.dataTransfer || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      var folderRow = event.target.closest("[data-folder-id]");
      setDropTarget(folderRow || workspaceContent);
      event.dataTransfer.dropEffect = "copy";
    });
    workspaceContent.addEventListener("dragleave", function (event) {
      if (!workspaceContent.contains(event.relatedTarget)) setDropTarget(null);
    });
    workspaceContent.addEventListener("drop", function (event) {
      if (!event.dataTransfer || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      var folderRow = event.target.closest("[data-folder-id]");
      var folderInput = uploadForm ? uploadForm.querySelector('input[name="folder_id"]') : null;
      var destination = folderRow ? folderRow.dataset.folderId : (folderInput ? folderInput.value : "");
      setDropTarget(null);
      uploadDroppedFiles(Array.from(event.dataTransfer.files || []), destination);
    });
  }

  var searchInput = document.getElementById("file-search");
  var globalSearchClear = document.getElementById("global-search-clear");
  var typeFilterButton = document.getElementById("type-filter-button");
  var typeFilterMenu = document.getElementById("type-filter-menu");
  var dateFilterButton = document.getElementById("date-filter-button");
  var dateFilterMenu = document.getElementById("date-filter-menu");
  var clearFiltersButton = document.getElementById("clear-filters-button");
  var removeFilter = document.getElementById("remove-filter");
  var resultCount = document.getElementById("result-count");
  var noResults = document.getElementById("no-search-results");
  var sectionedFolderView = document.querySelector("[data-sectioned-folder-view]");
  var fileTableWrap = sectionedFolderView ? null : document.querySelector(".file-workspace .table-wrap");
  var fileRows = Array.from(document.querySelectorAll(sectionedFolderView ? ".workspace-item" : ".file-table tbody tr"));
  var sortButton = document.getElementById("sort-button");
  var sortDirectionButton = document.getElementById("sort-direction-button");
  var sortMenu = document.getElementById("sort-menu");
  var fileTableBody = document.querySelector(".file-table tbody");
  var sortOptions = sortMenu ? Array.from(sortMenu.querySelectorAll("button[data-sort-field]")) : [];
  var workspaceState = new URLSearchParams(window.location.search);
  var loadedSearchQuery = workspaceState.get("search") || "";
  var searchRequestTimer = null;
  var searchRequestController = null;
  var activeSortField = ["date", "name", "size"].includes(workspaceState.get("sort")) ? workspaceState.get("sort") : "date";
  var activeSortDirection = workspaceState.get("direction") === "asc" ? "asc" : "desc";
  if (searchInput && workspaceState.has("search")) searchInput.value = workspaceState.get("search");
  function updateGlobalSearchClear() {
    if (globalSearchClear && searchInput) globalSearchClear.hidden = !searchInput.value;
  }
  updateGlobalSearchClear();
  function updateFilenameExtensions() {
    document.querySelectorAll(".file-name a").forEach(function (link) {
      var stem = link.querySelector(".file-name-stem");
      var extension = link.querySelector(".file-name-extension");
      if (!stem || !extension) return;
      link.classList.remove("filename-truncated");
      if (stem.scrollWidth > stem.clientWidth) link.classList.add("filename-truncated");
    });
  }
  updateFilenameExtensions();
  window.addEventListener("resize", updateFilenameExtensions);
  function bindFileRowPreviews() {
    fileRows.forEach(function (row) {
      var navigationUrl = row.dataset.previewUrl || (row.dataset.kind === "event" ? row.dataset.openUrl : "");
      if (!navigationUrl || row.dataset.previewBound === "true") return;
      row.dataset.previewBound = "true";
      row.addEventListener("click", function (event) {
        if (event.target.closest("a, button, input, label, select, textarea, .item-actions-card")) return;
        window.location.href = navigationUrl;
      });
    });
  }
  bindFileRowPreviews();
  function initializeFolderCarousels(root) {
    (root || document).querySelectorAll("[data-folder-carousel]").forEach(function (carousel) {
      if (carousel.dataset.carouselInitialized === "true") return;
      carousel.dataset.carouselInitialized = "true";
      var viewport = carousel.querySelector(".folder-carousel-viewport");
      var track = carousel.querySelector(".folder-carousel-track");
      var previous = carousel.querySelector("[data-carousel-previous]");
      var next = carousel.querySelector("[data-carousel-next]");
      if (!viewport || !track) return;
      var isGridCarousel = carousel.dataset.carouselGrid === "true";
      var index = 0;
      var timer = null;
      function visibleCards() {
        return Array.from(track.querySelectorAll(".folder-content-card")).filter(function (card) { return !card.hidden; });
      }
      function gridRows() {
        var rows = [];
        var trackTop = track.getBoundingClientRect().top;
        visibleCards().forEach(function (card) {
          var cardBounds = card.getBoundingClientRect();
          var top = Math.round(cardBounds.top - trackTop);
          var row = rows.find(function (candidate) { return candidate.top === top; });
          if (!row) {
            row = { top: top, height: 0 };
            rows.push(row);
          }
          row.height = Math.max(row.height, cardBounds.height);
        });
        return rows;
      }
      function cardStep() {
        var cards = visibleCards();
        if (!cards.length) return 0;
        var styles = window.getComputedStyle(track);
        return cards[0].getBoundingClientRect().width + (parseFloat(styles.gap) || 0);
      }
      function render() {
        var cards = visibleCards();
        if (!cards.length) return;
        if (isGridCarousel) {
          var rows = gridRows();
          if (!rows.length) return;
          index = Math.min(index, rows.length - 1);
          viewport.style.height = rows[index].height + "px";
          track.style.transform = "translateY(-" + rows[index].top + "px)";
          return;
        }
        var step = cardStep();
        var maxOffset = Math.max(0, track.scrollWidth - viewport.clientWidth);
        var offset = Math.min(index * step, maxOffset);
        track.style.transform = "translateX(-" + offset + "px)";
      }
      function move(direction) {
        var itemCount = isGridCarousel ? gridRows().length : visibleCards().length;
        if (itemCount < 2) return;
        index = (index + direction + itemCount) % itemCount;
        render();
      }
      function stop() {
        if (timer) window.clearInterval(timer);
        timer = null;
      }
      function start() {
        stop();
        var itemCount = isGridCarousel ? gridRows().length : visibleCards().length;
        if (itemCount > 1 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          timer = window.setInterval(function () { move(1); }, 3000);
        }
      }
      if (previous) previous.addEventListener("click", function () { move(-1); start(); });
      if (next) next.addEventListener("click", function () { move(1); start(); });
      carousel.addEventListener("mouseenter", stop);
      carousel.addEventListener("mouseleave", start);
      carousel.addEventListener("focusin", stop);
      carousel.addEventListener("focusout", start);
      carousel.addEventListener("folder-carousel-refresh", function () { index = 0; render(); start(); });
      window.addEventListener("resize", render);
      render();
      start();
    });
  }
  initializeFolderCarousels(document);
  var powerpointViewerLoader = null;
  function loadPresentationScript(source, ready) {
    if (ready()) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var absoluteSource = new URL(source, document.baseURI).href;
      var script = Array.from(document.scripts).find(function (candidate) { return candidate.src === absoluteSource; });
      if (!script) {
        script = document.createElement("script");
        script.src = source;
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", function () { ready() ? resolve() : reject(new Error("Presentation dependency unavailable")); }, { once: true });
      script.addEventListener("error", function () { reject(new Error("Presentation dependency failed to load")); }, { once: true });
    });
  }
  function ensurePowerpointViewer() {
    if (window.PptxViewJS) return Promise.resolve();
    if (!powerpointViewerLoader) {
      powerpointViewerLoader = loadPresentationScript("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js", function () { return Boolean(window.JSZip); })
        .then(function () { return loadPresentationScript("https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js", function () { return Boolean(window.Chart); }); })
        .then(function () { return loadPresentationScript("https://cdn.jsdelivr.net/npm/pptxviewjs/dist/PptxViewJS.min.js", function () { return Boolean(window.PptxViewJS); }); });
    }
    return powerpointViewerLoader;
  }
  function initializeInlinePowerpointPreviews(root) {
    (root || document).querySelectorAll("[data-inline-powerpoint-preview]").forEach(function (preview) {
      if (preview.dataset.powerpointInitialized === "true") return;
      preview.dataset.powerpointInitialized = "true";
      var canvas = preview.querySelector("[data-powerpoint-canvas]");
      var message = preview.querySelector("[data-powerpoint-message]");
      var status = preview.querySelector("[data-powerpoint-status]");
      var previous = preview.querySelector("[data-powerpoint-previous]");
      var next = preview.querySelector("[data-powerpoint-next]");
      var stage = preview.querySelector(".inline-presentation-stage");
      if (!canvas || !message || !status || !previous || !next) return;
      if (stage) stage.addEventListener("click", function (event) { event.stopPropagation(); });
      function unavailable(text) {
        canvas.classList.remove("is-ready");
        message.hidden = false;
        message.textContent = text;
        status.textContent = "Preview unavailable";
        previous.disabled = true;
        next.disabled = true;
      }
      ensurePowerpointViewer().then(function () {
        return fetch(preview.dataset.contentUrl);
      }).then(function (response) {
        if (!response.ok) throw new Error("Presentation request failed");
        return response.blob();
      }).then(async function (blob) {
        var presentationFile = new File([blob], preview.dataset.filename || "presentation." + preview.dataset.extension, { type: blob.type });
        var viewer = new window.PptxViewJS.PPTXViewer({ canvas: canvas });
        await viewer.loadFile(presentationFile);
        await viewer.render();
        canvas.classList.add("is-ready");
        message.hidden = true;
        function updateControls() {
          var current = viewer.getCurrentSlideIndex() + 1;
          var total = viewer.getSlideCount();
          status.textContent = "Page " + current + " of " + total;
          previous.disabled = current <= 1;
          next.disabled = current >= total;
        }
        previous.addEventListener("click", async function () {
          previous.disabled = true;
          next.disabled = true;
          await viewer.previousSlide();
          updateControls();
        });
        next.addEventListener("click", async function () {
          previous.disabled = true;
          next.disabled = true;
          await viewer.nextSlide();
          updateControls();
        });
        updateControls();
      }).catch(function () {
        unavailable(preview.dataset.extension === "ppt"
          ? "Inline preview is unavailable for this legacy .ppt file. Use Open / Preview or download the original file."
          : "This presentation could not be rendered. Use Open / Preview or download the original file.");
      });
    });
  }
  initializeInlinePowerpointPreviews(document);
  var folderPreviewModal = document.getElementById("folder-preview-modal");
  var folderPreviewFrame = document.getElementById("folder-preview-frame");
  var closeFolderPreviewButton = document.getElementById("close-folder-preview");
  function closeFolderPreview() {
    if (!folderPreviewModal) return;
    folderPreviewModal.hidden = true;
    document.body.classList.remove("folder-preview-open");
    if (folderPreviewFrame) folderPreviewFrame.src = "about:blank";
  }
  document.addEventListener("click", function (event) {
    var previewButton = event.target.closest("[data-fullscreen-preview]");
    if (!previewButton || !folderPreviewModal || !folderPreviewFrame) return;
    event.preventDefault();
    folderPreviewFrame.src = previewButton.dataset.fullscreenPreview;
    folderPreviewModal.hidden = false;
    document.body.classList.add("folder-preview-open");
    if (closeFolderPreviewButton) closeFolderPreviewButton.focus();
  });
  if (closeFolderPreviewButton) closeFolderPreviewButton.addEventListener("click", closeFolderPreview);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && folderPreviewModal && !folderPreviewModal.hidden) closeFolderPreview();
  });
  function sortFileRows(field, direction) {
    if (!fileTableBody || sectionedFolderView) return;
    activeSortField = field;
    activeSortDirection = direction;
    sortOptions.forEach(function (option) {
      option.classList.toggle("is-selected", option.dataset.sortField === field);
    });
    if (sortDirectionButton) {
      var directionIcon = sortDirectionButton.querySelector("i");
      var isAscending = direction === "asc";
      if (directionIcon) directionIcon.className = "bi " + (isAscending ? "bi-sort-up" : "bi-sort-down");
      sortDirectionButton.setAttribute("aria-label", isAscending ? "Sort ascending" : "Sort descending");
      sortDirectionButton.setAttribute("title", isAscending ? "Sort ascending" : "Sort descending");
    }
    var multiplier = direction === "desc" ? -1 : 1;
    fileRows.sort(function (firstRow, secondRow) {
      var workspace = fileTableBody ? fileTableBody.closest(".file-table").dataset.workspace : "files";
      if (workspace !== "recent" && firstRow.dataset.kind !== secondRow.dataset.kind) {
        return firstRow.dataset.kind === "folder" ? -1 : 1;
      }
      var firstValue;
      var secondValue;
      if (field === "name") {
        firstValue = (firstRow.dataset.itemName || "").toLowerCase();
        secondValue = (secondRow.dataset.itemName || "").toLowerCase();
        return firstValue.localeCompare(secondValue) * multiplier;
      }
      if (field === "size") {
        firstValue = Number(firstRow.dataset.sortSize || -1);
        secondValue = Number(secondRow.dataset.sortSize || -1);
      } else {
        firstValue = new Date(firstRow.dataset.modifiedDate || 0).getTime();
        secondValue = new Date(secondRow.dataset.modifiedDate || 0).getTime();
      }
      return (firstValue - secondValue) * multiplier;
    });
    fileRows.forEach(function (row) { fileTableBody.appendChild(row); });
    updateFilenameExtensions();
    if (typeof filterState !== "undefined") syncWorkspaceState();
  }
  function bindSortControls() {
    if (!sortButton || !sortMenu || sortButton.dataset.sortBound === "true") return;
    sortButton.dataset.sortBound = "true";
    sortButton.addEventListener("click", function (event) {
      event.stopPropagation();
      sortMenu.hidden = !sortMenu.hidden;
      sortButton.setAttribute("aria-expanded", String(!sortMenu.hidden));
    });
    sortOptions.forEach(function (option) {
      option.addEventListener("click", function () {
        sortFileRows(option.dataset.sortField, activeSortDirection);
        sortMenu.hidden = true;
        sortButton.setAttribute("aria-expanded", "false");
      });
    });
  }
  bindSortControls();
  sortOptions.forEach(function (option) {
    option.classList.toggle("is-selected", option.dataset.sortField === activeSortField);
  });
  function bindSortDirectionControl() {
    if (!sortDirectionButton || sortDirectionButton.dataset.sortDirectionBound === "true") return;
    sortDirectionButton.dataset.sortDirectionBound = "true";
    sortDirectionButton.addEventListener("click", function () {
      var field = activeSortField || "date";
      var direction = activeSortDirection === "asc" ? "desc" : "asc";
      sortFileRows(field, direction);
    });
  }
  bindSortDirectionControl();
  sortFileRows(activeSortField, activeSortDirection);
  var dateFilterMode = dateFilterButton ? (dateFilterButton.dataset.dateFilterMode || "relative") : "relative";
  var exactDateFilterInput = document.getElementById("workspace-date-filter-input");
  var exactDateFilterDisplay = dateFilterMenu ? dateFilterMenu.querySelector(".event-filter-date-display") : null;
  var exactDateFilterField = dateFilterMenu ? dateFilterMenu.querySelector(".event-filter-date-field") : null;
  var clearExactDateFilter = document.getElementById("clear-exact-date-filter");
  var filterState = {
    type: ["folder", "image", "pdf", "document", "spreadsheet", "powerpoint", "video", "audio", "zip", "other"].includes(workspaceState.get("type")) ? workspaceState.get("type") : "all",
    date: dateFilterMode === "exact"
      ? (/^\d{4}-\d{2}-\d{2}$/.test(workspaceState.get("date") || "") ? workspaceState.get("date") : "all")
      : (["today", "7", "30", "365"].includes(workspaceState.get("date")) ? workspaceState.get("date") : "all")
  };
  var typeMap = { folder: "Folder", image: "Image", pdf: "PDF", document: "Document", spreadsheet: "Spreadsheet", powerpoint: "PowerPoint", video: "Video", audio: "Audio", zip: "ZIP", other: "Other" };
  var dateLabels = { today: "Today", "7": "Last 7 days", "30": "Last 30 days", "365": "Last year" };
  if (typeFilterMenu) {
    var savedTypeOption = typeFilterMenu.querySelector("input[value='" + filterState.type + "']");
    if (savedTypeOption) savedTypeOption.checked = true;
  }
  if (dateFilterMenu) {
    if (dateFilterMode === "relative") {
      var savedDateOption = dateFilterMenu.querySelector("input[value='" + filterState.date + "']");
      if (savedDateOption) savedDateOption.checked = true;
    } else if (exactDateFilterInput && filterState.date !== "all") {
      exactDateFilterInput.value = filterState.date;
    }
  }
  function pluralizeTypeLabel(typeKey) {
    var singular = typeMap[typeKey] || "Type";
    if (singular === "Image") return "Images";
    if (singular === "PDF") return "PDFs";
    if (singular === "Folder") return "Folders";
    if (singular === "Document") return "Documents";
    if (singular === "Spreadsheet") return "Spreadsheets";
    if (singular === "PowerPoint") return "PowerPoints";
    if (singular === "Video") return "Videos";
    if (singular === "Audio") return "Audios";
    if (singular === "ZIP") return "ZIP files";
    if (singular === "Other") return "Other";
    return singular + "s";
  }
  function setFilterButtonState(button, value, labels, defaultLabel) {
    if (!button) return;
    var label = button.querySelector(".filter-button-label");
    var icon = button.querySelector(".filter-button-icon");
    var isActive = value !== "all";
    if (label) {
      if (isActive && defaultLabel === "Type") {
        label.textContent = pluralizeTypeLabel(value);
      } else if (isActive && defaultLabel === "Date" && dateFilterMode === "exact") {
        label.textContent = formatLongDate(value) || defaultLabel;
      } else {
        label.textContent = isActive ? labels[value] : defaultLabel;
      }
    }
    if (icon) icon.className = "bi filter-button-icon " + (isActive ? "bi-x-lg" : "bi-caret-down-fill");
    button.classList.toggle("filter-active", isActive);
    button.setAttribute("title", isActive ? "Clear " + defaultLabel.toLowerCase() + " filter" : "Filter by " + defaultLabel.toLowerCase());
    button.setAttribute("aria-label", isActive ? "Clear " + defaultLabel.toLowerCase() + " filter" : "Filter by " + defaultLabel.toLowerCase());
  }
  function updateClearFiltersVisibility() {
    if (!clearFiltersButton) return;
    clearFiltersButton.hidden = filterState.type === "all" && filterState.date === "all";
  }
  function clearFilter(filterKey) {
    filterState[filterKey] = "all";
    var option = null;
    if (filterKey === "type") {
      option = typeFilterMenu ? typeFilterMenu.querySelector("input[value='all']") : null;
      if (option) option.checked = true;
      setFilterButtonState(typeFilterButton, filterState.type, typeMap, "Type");
    }
    if (filterKey === "date") {
      if (dateFilterMode === "relative") {
        option = dateFilterMenu ? dateFilterMenu.querySelector("input[value='all']") : null;
        if (option) option.checked = true;
      } else if (exactDateFilterInput) {
        exactDateFilterInput.value = "";
        if (exactDateFilterDisplay) exactDateFilterDisplay.textContent = "Select a date";
        if (exactDateFilterField) exactDateFilterField.classList.remove("has-value");
        if (clearExactDateFilter) clearExactDateFilter.hidden = true;
      }
      setFilterButtonState(dateFilterButton, filterState.date, dateLabels, "Date");
    }
    var allCleared = filterState.type === "all" && filterState.date === "all";
    if (removeFilter) removeFilter.hidden = allCleared;
    updateClearFiltersVisibility();
    applyFileFilters();
    syncWorkspaceState();
  }
  function closeFilterMenu(button, menu) {
    if (menu) menu.hidden = true;
    if (button) button.setAttribute("aria-expanded", "false");
  }
  function matchesTypeFilter(row) {
    if (filterState.type === "all") return true;
    return (row.dataset.fileType || "").toLowerCase() === filterState.type.toLowerCase();
  }
  function matchesDateFilter(row) {
    if (filterState.date === "all") return true;
    if (dateFilterMode === "exact") {
      var rowDate = (row.dataset.modifiedDate || "").slice(0, 10);
      return rowDate === filterState.date;
    }
    var modifiedDate = new Date(row.dataset.modifiedDate);
    if (Number.isNaN(modifiedDate.getTime())) return false;
    var now = new Date();
    if (filterState.date === "today") {
      return modifiedDate.toDateString() === now.toDateString();
    }
    var cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - Number(filterState.date));
    return modifiedDate >= cutoff;
  }
  function applyFileFilters() {
    var term = searchInput ? searchInput.value.toLowerCase().trim() : "";
    var shown = 0;
    fileRows.forEach(function (row) {
      var matchesSearch = row.textContent.toLowerCase().indexOf(term) !== -1;
      var matchesType = matchesTypeFilter(row);
      var matchesDate = matchesDateFilter(row);
      var visible = matchesSearch && matchesType && matchesDate;
      row.hidden = !visible;
      row.classList.toggle("filter-hidden", !visible);
      if (visible) shown += 1;
    });
    if (resultCount) resultCount.textContent = shown + " file" + (shown === 1 ? "" : "s");
    if (noResults) noResults.hidden = shown !== 0;
    if (fileTableWrap) fileTableWrap.hidden = shown === 0;
    if (sectionedFolderView) {
      sectionedFolderView.querySelectorAll("[data-folder-section]").forEach(function (sectionElement) {
        var sectionItems = Array.from(sectionElement.querySelectorAll(".workspace-item"));
        sectionElement.hidden = sectionItems.length > 0 && sectionItems.every(function (item) { return item.hidden; });
      });
      sectionedFolderView.hidden = shown === 0;
      sectionedFolderView.querySelectorAll("[data-folder-carousel]").forEach(function (carousel) {
        carousel.dispatchEvent(new Event("folder-carousel-refresh"));
      });
    }
  }
  var workspaceRefreshPromise = null;
  var workspaceRefreshQueued = false;
  function applyWorkspaceResultsHtml(html) {
    var resultDocument = new DOMParser().parseFromString(html, "text/html");
    var nextResults = resultDocument.getElementById("file-results");
    var currentResults = document.getElementById("file-results");
    if (!nextResults || !currentResults) throw new Error("Workspace results unavailable");
    currentResults.replaceWith(nextResults);
    var nextTitle = resultDocument.querySelector(".workspace-title h1");
    var currentTitle = document.querySelector(".workspace-title h1");
    if (nextTitle && currentTitle) currentTitle.textContent = nextTitle.textContent;
    var nextBreadcrumbs = resultDocument.getElementById("workspace-breadcrumbs");
    var currentBreadcrumbs = document.getElementById("workspace-breadcrumbs");
    if (nextBreadcrumbs && currentBreadcrumbs) currentBreadcrumbs.replaceWith(nextBreadcrumbs);
    sectionedFolderView = nextResults.querySelector("[data-sectioned-folder-view]");
    fileTableWrap = sectionedFolderView ? null : nextResults.querySelector(".table-wrap");
    noResults = nextResults.querySelector("#no-search-results");
    fileRows = Array.from(nextResults.querySelectorAll(sectionedFolderView ? ".workspace-item" : ".file-table tbody tr"));
    fileTableBody = nextResults.querySelector(".file-table tbody");
    sortButton = nextResults.querySelector("#sort-button");
    sortDirectionButton = nextResults.querySelector("#sort-direction-button");
    sortMenu = nextResults.querySelector("#sort-menu");
    sortOptions = sortMenu ? Array.from(sortMenu.querySelectorAll("button[data-sort-field]")) : [];
    folderDropRows = Array.from(nextResults.querySelectorAll("[data-folder-id]"));
    refreshBulkSelectionElements();
    setMobileSelectMode(false);
    bindFileRowPreviews();
    bindSortControls();
    bindSortDirectionControl();
    sortFileRows(activeSortField, activeSortDirection);
    initializeFolderCarousels(nextResults);
    initializeInlinePowerpointPreviews(nextResults);
    applyFileFilters();
    updateFilenameExtensions();
  }
  function refreshWorkspaceContents() {
    if (workspaceRefreshPromise) {
      workspaceRefreshQueued = true;
      return workspaceRefreshPromise;
    }
    var destination = currentWorkspaceUrl();
    workspaceRefreshPromise = fetch(destination.toString(), {
      headers: { "X-Requested-With": "XMLHttpRequest" }
    }).then(function (response) {
      if (!response.ok) throw new Error("Workspace refresh failed");
      return response.text();
    }).then(applyWorkspaceResultsHtml).catch(function () {
      showToast("The upload finished, but the workspace could not be refreshed.", "error");
    }).finally(function () {
      workspaceRefreshPromise = null;
      if (workspaceRefreshQueued) {
        workspaceRefreshQueued = false;
        refreshWorkspaceContents();
      }
    });
    return workspaceRefreshPromise;
  }
  function reloadGlobalSearch() {
    if (!searchInput || searchInput.value.trim() === loadedSearchQuery) return;
    var destination = currentWorkspaceUrl();
    var requestedSearchQuery = destination.searchParams.get("search") || "";
    if (searchRequestController) searchRequestController.abort();
    searchRequestController = new AbortController();
    fetch(destination.toString(), {
      headers: { "X-Requested-With": "XMLHttpRequest" },
      signal: searchRequestController.signal
    }).then(function (response) {
      if (!response.ok) throw new Error("Search request failed");
      return response.text();
    }).then(function (html) {
      if (searchInput.value !== requestedSearchQuery) return;
      applyWorkspaceResultsHtml(html);
      loadedSearchQuery = requestedSearchQuery;
      window.history.replaceState(null, "", destination.toString());
    }).catch(function (error) {
      if (error.name !== "AbortError") showToast("Search results could not be refreshed.", "error");
    });
  }
  if (searchInput) {
    searchInput.addEventListener("input", function () {
      updateGlobalSearchClear();
      applyFileFilters();
      if (searchRequestTimer) window.clearTimeout(searchRequestTimer);
      searchRequestTimer = window.setTimeout(reloadGlobalSearch, 250);
    });
    searchInput.addEventListener("keydown", function (event) {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (searchRequestTimer) window.clearTimeout(searchRequestTimer);
      reloadGlobalSearch();
    });
  }
  if (globalSearchClear && searchInput) globalSearchClear.addEventListener("click", function () {
    searchInput.value = "";
    updateGlobalSearchClear();
    searchInput.focus();
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  function positionFilterMenu(button, menu) {
    if (!button || !menu || menu.hidden) return;
    var viewportPadding = 8;
    menu.style.left = "0px";
    menu.style.right = "auto";
    var buttonRect = button.getBoundingClientRect();
    var menuRect = menu.getBoundingClientRect();
    var maximumLeft = Math.max(viewportPadding, window.innerWidth - menuRect.width - viewportPadding);
    var viewportLeft = Math.max(viewportPadding, Math.min(buttonRect.left, maximumLeft));
    menu.style.left = viewportLeft - buttonRect.left + "px";
    menuRect = menu.getBoundingClientRect();
    var availableHeight = Math.max(0, window.innerHeight - menuRect.top - viewportPadding);
    menu.style.maxHeight = Math.min(window.innerHeight * 0.7, 520, availableHeight) + "px";
  }
  function toggleFilterMenu(button, menu) {
    if (!button || !menu) return;
    var shouldOpen = menu.hidden;
    [typeFilterMenu, dateFilterMenu].forEach(function (otherMenu) {
      if (otherMenu) otherMenu.hidden = true;
    });
    [typeFilterButton, dateFilterButton].forEach(function (otherButton) {
      if (otherButton) otherButton.setAttribute("aria-expanded", "false");
    });
    menu.hidden = !shouldOpen;
    button.setAttribute("aria-expanded", String(shouldOpen));
    if (shouldOpen) positionFilterMenu(button, menu);
  }
  if (typeFilterButton && typeFilterMenu) {
    typeFilterButton.addEventListener("click", function (event) {
      event.stopPropagation();
      if (filterState.type !== "all") {
        clearFilter("type");
        return;
      }
      toggleFilterMenu(typeFilterButton, typeFilterMenu);
    });
    typeFilterMenu.querySelectorAll("input[name='file-type-filter']").forEach(function (option) {
      option.addEventListener("change", function () {
        filterState.type = option.value;
        setFilterButtonState(typeFilterButton, filterState.type, typeMap, "Type");
        closeFilterMenu(typeFilterButton, typeFilterMenu);
        var allCleared = filterState.type === "all" && filterState.date === "all";
        if (removeFilter) removeFilter.hidden = allCleared;
        updateClearFiltersVisibility();
        applyFileFilters();
        syncWorkspaceState();
      });
    });
  }
  if (dateFilterButton && dateFilterMenu) {
    dateFilterButton.addEventListener("click", function (event) {
      event.stopPropagation();
      if (filterState.date !== "all") {
        clearFilter("date");
        return;
      }
      toggleFilterMenu(dateFilterButton, dateFilterMenu);
    });
    if (dateFilterMode === "relative") {
      dateFilterMenu.querySelectorAll("input[name='file-date-filter']").forEach(function (option) {
        option.addEventListener("change", function () {
          filterState.date = option.value;
          setFilterButtonState(dateFilterButton, filterState.date, dateLabels, "Date");
          closeFilterMenu(dateFilterButton, dateFilterMenu);
          var allCleared = filterState.type === "all" && filterState.date === "all";
          if (removeFilter) removeFilter.hidden = allCleared;
          updateClearFiltersVisibility();
          applyFileFilters();
          syncWorkspaceState();
        });
      });
    } else if (exactDateFilterInput) {
      function syncExactDateFilterDisplay() {
        var formatted = formatLongDate(exactDateFilterInput.value);
        if (exactDateFilterDisplay) exactDateFilterDisplay.textContent = formatted || "Select a date";
        if (exactDateFilterField) exactDateFilterField.classList.toggle("has-value", Boolean(formatted));
        if (clearExactDateFilter) clearExactDateFilter.hidden = !formatted;
      }
      syncExactDateFilterDisplay();
      exactDateFilterInput.addEventListener("change", function () {
        filterState.date = exactDateFilterInput.value || "all";
        syncExactDateFilterDisplay();
        setFilterButtonState(dateFilterButton, filterState.date, dateLabels, "Date");
        closeFilterMenu(dateFilterButton, dateFilterMenu);
        updateClearFiltersVisibility();
        applyFileFilters();
        syncWorkspaceState();
      });
      exactDateFilterInput.addEventListener("input", syncExactDateFilterDisplay);
      if (clearExactDateFilter) clearExactDateFilter.addEventListener("click", function () {
        clearFilter("date");
        closeFilterMenu(dateFilterButton, dateFilterMenu);
      });
    }
  }
  if (clearFiltersButton) {
    clearFiltersButton.addEventListener("click", function (event) {
      event.stopPropagation();
      filterState.type = "all";
      filterState.date = "all";
      var typeOption = typeFilterMenu ? typeFilterMenu.querySelector("input[value='all']") : null;
      if (typeOption) typeOption.checked = true;
      if (dateFilterMode === "relative") {
        var dateOption = dateFilterMenu ? dateFilterMenu.querySelector("input[value='all']") : null;
        if (dateOption) dateOption.checked = true;
      } else if (exactDateFilterInput) {
        exactDateFilterInput.value = "";
        if (exactDateFilterDisplay) exactDateFilterDisplay.textContent = "Select a date";
        if (exactDateFilterField) exactDateFilterField.classList.remove("has-value");
        if (clearExactDateFilter) clearExactDateFilter.hidden = true;
      }
      setFilterButtonState(typeFilterButton, filterState.type, typeMap, "Type");
      setFilterButtonState(dateFilterButton, filterState.date, dateLabels, "Date");
      updateClearFiltersVisibility();
      if (removeFilter) removeFilter.hidden = true;
      applyFileFilters();
      syncWorkspaceState();
    });
  }
  setFilterButtonState(typeFilterButton, filterState.type, typeMap, "Type");
  setFilterButtonState(dateFilterButton, filterState.date, dateLabels, "Date");
  updateClearFiltersVisibility();
  applyFileFilters();
  window.addEventListener("resize", function () {
    positionFilterMenu(typeFilterButton, typeFilterMenu);
    positionFilterMenu(dateFilterButton, dateFilterMenu);
  });
  document.addEventListener("click", function (event) {
    if (sortMenu && sortButton && !sortMenu.hidden && !sortMenu.contains(event.target) && !sortButton.contains(event.target)) {
      sortMenu.hidden = true;
      sortButton.setAttribute("aria-expanded", "false");
    }
    [[typeFilterButton, typeFilterMenu], [dateFilterButton, dateFilterMenu]].forEach(function (control) {
      var button = control[0];
      var menu = control[1];
      if (button && menu && !menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) {
        menu.hidden = true;
        button.setAttribute("aria-expanded", "false");
      }
    });
  });
  if (removeFilter) removeFilter.addEventListener("click", function () {
    activeFilter = "all";
    activeDateFilter = "all";
    var allOption = document.querySelector("input[name='file-type-filter'][value='all']");
    if (allOption) allOption.checked = true;
    if (dateFilterMode === "relative") {
      var allDateOption = document.querySelector("input[name='file-date-filter'][value='all']");
      if (allDateOption) allDateOption.checked = true;
    } else if (exactDateFilterInput) {
      exactDateFilterInput.value = "";
      if (exactDateFilterDisplay) exactDateFilterDisplay.textContent = "Select a date";
      if (exactDateFilterField) exactDateFilterField.classList.remove("has-value");
      if (clearExactDateFilter) clearExactDateFilter.hidden = true;
    }
    setFilterButtonState(typeFilterButton, activeFilter, typeMap, "Type");
    setFilterButtonState(dateFilterButton, activeDateFilter, dateLabels, "Date");
    removeFilter.hidden = true;
    applyFileFilters();
  });

  var itemActionsModal = document.getElementById("item-actions-modal");
  var renameItemModal = document.getElementById("rename-item-modal");
  var editEventModal = document.getElementById("edit-event-modal");
  var itemActionsName = document.getElementById("item-actions-name");
  var itemActionsTitle = document.getElementById("item-actions-title");
  var openItem = document.getElementById("open-item");
  var copyItemLink = document.getElementById("copy-item-link");
  var renameItemButton = document.getElementById("rename-item");
  var renameItemLabel = document.getElementById("rename-item-label");
  var starItemButton = document.getElementById("star-item");
  var moveItemButton = document.getElementById("move-item");
  var downloadItem = document.getElementById("download-item");
  var deleteItemButton = document.getElementById("delete-item");
  var propertiesItemButton = document.getElementById("properties-item");
  var offlineItemButton = document.getElementById("offline-item");
  var restoreItemButton = document.getElementById("restore-item");
  var permanentDeleteItemButton = document.getElementById("permanent-delete-item");
  var itemProperties = document.getElementById("item-properties");
  var propertiesPanel = document.getElementById("properties-panel");
  var propertiesPanelList = document.getElementById("properties-panel-list");
  var closePropertiesPanel = document.getElementById("close-properties-panel");
  var propertiesPanelCloseTimer = null;
  var propertiesPanelTransitionHandler = null;
  var renameItemForm = document.getElementById("rename-item-form");
  var editEventForm = document.getElementById("edit-event-form");
  var cancelRenameItem = document.getElementById("cancel-rename-item");
  var renameItemName = document.getElementById("rename-item-name");
  var renameItemExtension = document.getElementById("rename-item-extension");
  var editEventId = document.getElementById("edit-event-id");
  var editEventName = document.getElementById("edit-event-name");
  var editEventIconPicker = document.getElementById("edit-event-icon-picker");
  var cancelEditEvent = document.getElementById("cancel-edit-event");
  var activeItemRow = null;
  var activeItemActionButton = null;
  var starredRemovalTimers = {};
  function closeItemActions() {
    if (itemActionsModal) itemActionsModal.hidden = true;
    if (itemProperties) itemProperties.hidden = true;
    if (activeItemActionButton) activeItemActionButton.setAttribute("aria-expanded", "false");
    if (itemActionsModal) {
      delete itemActionsModal.dataset.itemId;
      delete itemActionsModal.dataset.itemKind;
    }
    activeItemActionButton = null;
    activeItemRow = null;
  }
  function getSelectionForRow(row) {
    if (!row) return null;
    return itemSelections.find(function (input) {
      return input.value === row.dataset.kind + ":" + row.dataset.itemId;
    }) || null;
  }
  function selectOnlyRow(row) {
    var selection = getSelectionForRow(row);
    if (!selection) return null;
    itemSelections.forEach(function (input) {
      input.checked = input === selection;
    });
    updateBulkToolbar();
    return selection;
  }
  function closeRenameItem() {
    if (renameItemModal) renameItemModal.hidden = true;
  }
  function closeEditEvent() {
    if (editEventModal) editEventModal.hidden = true;
  }
  function closeProperties() {
    if (!propertiesPanel) return;
    if (propertiesPanelCloseTimer) window.clearTimeout(propertiesPanelCloseTimer);
    if (propertiesPanelTransitionHandler) propertiesPanel.removeEventListener("transitionend", propertiesPanelTransitionHandler);
    propertiesPanel.classList.remove("is-open");
    var finishClosing = function () {
      if (propertiesPanelCloseTimer) window.clearTimeout(propertiesPanelCloseTimer);
      if (propertiesPanelTransitionHandler) propertiesPanel.removeEventListener("transitionend", propertiesPanelTransitionHandler);
      propertiesPanel.hidden = true;
      document.querySelector(".workspace-content").classList.remove("properties-open");
      propertiesPanelCloseTimer = null;
      propertiesPanelTransitionHandler = null;
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finishClosing();
    } else {
      propertiesPanelTransitionHandler = function (event) {
        if (event.target === propertiesPanel && event.propertyName === "transform") finishClosing();
      };
      propertiesPanel.addEventListener("transitionend", propertiesPanelTransitionHandler);
      propertiesPanelCloseTimer = window.setTimeout(finishClosing, 180);
    }
  }
  function positionItemActions() {
    if (!itemActionsModal || itemActionsModal.hidden || !activeItemRow) return;
    var card = itemActionsModal.querySelector(".item-actions-card");
    if (!activeItemActionButton || !card) return;
    var buttonRect = activeItemActionButton.getBoundingClientRect();
    var gap = 8;
    var margin = 8;
    var left = buttonRect.right - card.offsetWidth;
    var top = buttonRect.bottom + gap;
    if (top + card.offsetHeight > window.innerHeight - margin) {
      top = buttonRect.top - card.offsetHeight - gap;
    }
    card.style.left = Math.max(margin, Math.min(left, window.innerWidth - card.offsetWidth - margin)) + "px";
    card.style.top = Math.max(margin, Math.min(top, window.innerHeight - card.offsetHeight - margin)) + "px";
  }
  function openItemActions(row, triggerButton) {
    if (!itemActionsModal || !row || !triggerButton || !row.dataset.itemId || !row.dataset.kind) return;
    if (activeItemActionButton && activeItemActionButton !== triggerButton) {
      activeItemActionButton.setAttribute("aria-expanded", "false");
    }
    activeItemRow = row;
    activeItemActionButton = triggerButton;
    itemActionsModal.dataset.itemId = row.dataset.itemId;
    itemActionsModal.dataset.itemKind = row.dataset.kind;
    var name = row.dataset.itemDisplayName || row.dataset.itemName || "Item";
    itemActionsName.textContent = name;
    itemActionsTitle.textContent = row.dataset.kind === "folder" ? "Folder actions" : row.dataset.kind === "event" ? "Event actions" : "File actions";
    if (renameItemLabel) renameItemLabel.textContent = row.dataset.kind === "event" ? "Edit" : "Rename";
    if (openItem) {
      openItem.href = row.dataset.openUrl || "#";
      openItem.hidden = !row.dataset.openUrl;
    }
    if (downloadItem) downloadItem.href = row.dataset.downloadUrl;
    if (offlineItemButton) {
      offlineItemButton.dataset.offlineUrl = triggerButton.dataset.offlineUrl || "";
      offlineItemButton.hidden = !offlineItemButton.dataset.offlineUrl;
      if (!offlineItemButton.hidden) syncOfflineAction(offlineItemButton);
    }
    if (copyItemLink) {
      var publicWorkspaceContainer = row.closest("[data-public-workspace='true']");
      var isPublicRow = Boolean(publicWorkspaceContainer);
      var copyUrl = row.dataset.copyUrl || (isPublicRow && row.dataset.openUrl ? new URL(row.dataset.openUrl, window.location.href).href : "");
      copyItemLink.dataset.copyUrl = copyUrl;
      copyItemLink.hidden = !copyUrl;
    }
    if (starItemButton) {
      var starToggle = row.querySelector(".toggle-star");
      var isStarred = starToggle && starToggle.dataset.starred === "false";
      starItemButton.innerHTML = isStarred ? '<i class="bi bi-star-fill"></i> Unstar' : '<i class="bi bi-star"></i> Star';
    }
    itemActionsModal.hidden = false;
    activeItemActionButton.setAttribute("aria-expanded", "true");
    positionItemActions();
  }
  function submitStarUpdate(selection, starToggle) {
    if (!bulkForm || !selection || !starToggle) return;
    var pendingRow = starToggle.closest(".workspace-item, tr");
    var pendingRowKey = pendingRow ? pendingRow.dataset.kind + ":" + pendingRow.dataset.itemId : "";
    if (starToggle.dataset.starred === "true" && pendingRowKey && starredRemovalTimers[pendingRowKey]) {
      window.clearTimeout(starredRemovalTimers[pendingRowKey]);
      delete starredRemovalTimers[pendingRowKey];
    }
    var csrfToken = bulkForm.querySelector("input[name='csrf_token']");
    var payload = new FormData();
    if (csrfToken) payload.append("csrf_token", csrfToken.value);
    payload.append("items", selection.value);
    payload.append("starred", starToggle.dataset.starred);

    fetch("/items/star", {
      method: "POST",
      body: payload,
      headers: { "X-Requested-With": "XMLHttpRequest" }
    }).then(function (response) {
      if (!response.ok) throw new Error("Star update failed");
      return response.json();
    }).then(function (result) {
      if (!result.ok) throw new Error("Star update failed");
      var isStarred = starToggle.dataset.starred === "true";
      starToggle.dataset.starred = isStarred ? "false" : "true";
      starToggle.classList.toggle("is-starred", isStarred);
      starToggle.setAttribute("aria-label", isStarred ? "Remove from Starred" : "Add to Starred");
      starToggle.setAttribute("title", isStarred ? "Unstar" : "Star");
      var starIcon = starToggle.querySelector("i");
      if (starIcon) starIcon.className = isStarred ? "bi bi-star-fill" : "bi bi-star";
      if (activeItemRow === starToggle.closest(".workspace-item, tr") && starItemButton) {
        starItemButton.innerHTML = isStarred ? '<i class="bi bi-star-fill"></i> Unstar' : '<i class="bi bi-star"></i> Star';
      }
      var row = starToggle.closest(".workspace-item, tr");
      var rowKey = row ? row.dataset.kind + ":" + row.dataset.itemId : "";
      var workspace = fileTableBody ? fileTableBody.closest(".file-table").dataset.workspace : "";
      if (rowKey && starredRemovalTimers[rowKey]) {
        window.clearTimeout(starredRemovalTimers[rowKey]);
        delete starredRemovalTimers[rowKey];
      }
      if (row && !isStarred && workspace === "starred") {
        starredRemovalTimers[rowKey] = window.setTimeout(function () {
          row.remove();
          fileRows = fileRows.filter(function (fileRow) { return fileRow !== row; });
          delete starredRemovalTimers[rowKey];
          applyFileFilters();
        }, 1000);
      }
      updateBulkToolbar();
      showToast(isStarred ? "Added to Starred." : "Removed from Starred.", "success");
    }).catch(function () {
      showToast("The star update could not be completed.", "error");
    });
  }
  document.addEventListener("click", function (event) {
    var button = event.target.closest(".file-workspace .more-actions-button");
    if (button) {
      event.preventDefault();
      var targetModal = document.getElementById(button.dataset.itemActionsTarget || "");
      var row = button.closest(".workspace-item, .file-table tbody tr");
      if (targetModal !== itemActionsModal || !row || button.dataset.itemId !== row.dataset.itemId || button.dataset.itemKind !== row.dataset.kind) return;
      if (itemActionsModal && !itemActionsModal.hidden && activeItemRow === row && activeItemActionButton === button) {
        closeItemActions();
        return;
      }
      openItemActions(row, button);
      return;
    }
    if (!itemActionsModal || itemActionsModal.hidden || !activeItemRow) return;
    var card = itemActionsModal.querySelector(".item-actions-card");
    if (card && !card.contains(event.target)) closeItemActions();
  });
  document.getElementById("close-item-actions")?.addEventListener("click", closeItemActions);
  if (itemActionsModal) itemActionsModal.addEventListener("click", function (event) {
    if (event.target === itemActionsModal) closeItemActions();
  });
  window.addEventListener("resize", positionItemActions);
  window.addEventListener("scroll", positionItemActions, true);
  if (copyItemLink) copyItemLink.addEventListener("click", function () {
    var row = activeItemRow;
    if (!row) return;
    navigator.clipboard.writeText(copyItemLink.dataset.copyUrl || row.dataset.copyUrl).then(function () {
      showToast("Link copied.", "success");
    }).catch(function () {
      showToast("Copy failed. Please try again.", "error");
    });
  });
  if (renameItemButton) renameItemButton.addEventListener("click", function () {
    var row = activeItemRow;
    if (!row) return;
    closeItemActions();
    var isEvent = row.dataset.kind === "event";
    var itemName = row.dataset.itemName || "";
    if (isEvent) {
      if (editEventModal) editEventModal.hidden = false;
      if (editEventId) editEventId.value = row.dataset.itemId;
      if (editEventName) editEventName.value = itemName;
      if (editEventIconPicker) {
        var selectedIcon = row.dataset.itemIcon || "event";
        var targetRadio = editEventIconPicker.querySelector("input[name='event_type'][value='" + selectedIcon + "']") || editEventIconPicker.querySelector("input[name='event_type'][value='event']");
        if (targetRadio) targetRadio.checked = true;
      }
      if (editEventName) editEventName.focus();
      return;
    }
    if (renameItemModal) renameItemModal.hidden = false;
    document.getElementById("rename-item-kind").value = row.dataset.kind;
    document.getElementById("rename-item-id").value = row.dataset.itemId;
    var extensionStart = itemName.lastIndexOf(".");
    var hasExtension = row.dataset.kind === "file" && extensionStart > 0 && extensionStart < itemName.length - 1;
    renameItemName.value = hasExtension ? itemName.substring(0, extensionStart) : itemName;
    renameItemExtension.textContent = hasExtension ? itemName.substring(extensionStart) : "";
    renameItemExtension.hidden = !hasExtension;
    renameItemName.focus();
  });
  if (renameItemForm) renameItemForm.addEventListener("submit", function () {
    addWorkspaceReturnTarget(renameItemForm);
  });
  if (editEventForm) editEventForm.addEventListener("submit", function () {
    addWorkspaceReturnTarget(editEventForm);
  });
  if (starItemButton) starItemButton.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    var row = activeItemRow;
    if (!row || !bulkForm) return;
    var selection = getSelectionForRow(row);
    var starToggle = row.querySelector(".toggle-star");
    if (!selection || !starToggle) return;
    closeItemActions();
    submitStarUpdate(selection, starToggle);
  });
  if (cancelRenameItem) cancelRenameItem.addEventListener("click", closeRenameItem);
  if (cancelEditEvent) cancelEditEvent.addEventListener("click", closeEditEvent);
  // if (renameItemModal) renameItemModal.addEventListener("click", function (event) {
  //   if (event.target === renameItemModal) closeRenameItem();
  // });
  if (propertiesItemButton) propertiesItemButton.addEventListener("click", function () {
    var row = activeItemRow;
    if (!row) return;
    var propertiesMarkup = "<dt>Name</dt><dd>" + escapeHtml(row.dataset.itemDisplayName || row.dataset.itemName) + "</dd>" +
      "<dt>Type</dt><dd>" + escapeHtml(row.dataset.itemType) + "</dd>" +
      "<dt>Size</dt><dd>" + escapeHtml(row.dataset.itemSize) + "</dd>" +
      "<dt>Location</dt><dd>" + escapeHtml(row.dataset.itemLocation || "Library") + "</dd>" +
      "<dt>" + escapeHtml(row.dataset.itemDateLabel || "Created or uploaded") + "</dt><dd>" + escapeHtml(row.dataset.itemModified) + "</dd>" +
      (row.dataset.itemExpiration ? "<dt>Auto delete in</dt><dd>" + escapeHtml(row.dataset.itemExpiration) + "</dd>" : "") +
      (["file", "folder"].includes(row.dataset.kind) ? "<dt>Last accessed</dt><dd>" + escapeHtml(row.dataset.itemAccessed || "—") + "</dd>" : "") +
      "<dt>Starred</dt><dd>" + (row.querySelector(".toggle-star") && row.querySelector(".toggle-star").dataset.starred === "false" ? "Yes" : "No") + "</dd>";
    if (propertiesPanel && propertiesPanelList) {
      if (propertiesPanelCloseTimer) window.clearTimeout(propertiesPanelCloseTimer);
      if (propertiesPanelTransitionHandler) propertiesPanel.removeEventListener("transitionend", propertiesPanelTransitionHandler);
      propertiesPanelCloseTimer = null;
      propertiesPanelTransitionHandler = null;
      propertiesPanelList.innerHTML = propertiesMarkup;
      propertiesPanel.hidden = false;
      document.querySelector(".workspace-content").classList.add("properties-open");
      window.requestAnimationFrame(function () {
        propertiesPanel.classList.add("is-open");
      });
      closeItemActions();
    }
  });
  if (closePropertiesPanel) closePropertiesPanel.addEventListener("click", function () {
    closeProperties();
  });
  if (deleteItemButton) deleteItemButton.addEventListener("click", function () {
    var row = activeItemRow;
    if (!row || !bulkForm) return;
    var selection = selectOnlyRow(row);
    if (!selection) return;
    showCustomConfirm("Move this item to Trash?", "Move to Trash", true, function () {
      closeItemActions();
      bulkForm.action = "/items/trash";
      addWorkspaceReturnTarget(bulkForm);
      bulkForm.submit();
    });
  });
  if (restoreItemButton) restoreItemButton.addEventListener("click", function () {
    var row = activeItemRow;
    if (!row || !bulkForm) return;
    var selection = selectOnlyRow(row);
    if (!selection) return;
    bulkForm.action = "/items/restore";
    addWorkspaceReturnTarget(bulkForm);
    bulkForm.submit();
  });
  if (permanentDeleteItemButton) permanentDeleteItemButton.addEventListener("click", function () {
    var row = activeItemRow;
    if (!row || !bulkForm) return;
    var selection = selectOnlyRow(row);
    if (!selection) return;
    showCustomConfirm("Permanently delete this item? This cannot be undone.", "Delete permanently", true, function () {
      bulkForm.action = "/items/permanent-delete";
      addWorkspaceReturnTarget(bulkForm);
      bulkForm.submit();
    });
  });
  document.querySelectorAll("button[data-row-action]").forEach(function (button) {
    button.addEventListener("click", function () {
      if (!bulkForm) return;
      var row = button.closest(".workspace-item, tr");
      var selection = selectOnlyRow(row);
      if (!selection) return;
      function submitRowAction() {
        bulkForm.action = button.dataset.rowAction === "restore" ? "/items/restore" : "/items/permanent-delete";
        addWorkspaceReturnTarget(bulkForm);
        bulkForm.submit();
      }
      if (button.dataset.rowAction === "permanent-delete") {
        showCustomConfirm("Permanently delete this item? This cannot be undone.", "Delete permanently", true, submitRowAction);
      } else {
        submitRowAction();
      }
    });
  });

  var newFolderButton = document.getElementById("new-folder-button");
  var newEventButton = document.getElementById("new-event-button");
  var eventsHomeAddEvent = document.getElementById("events-home-add-event");
  var dateWorkspaceAddEvent = document.getElementById("date-workspace-add-event");
  var dateWorkspaceAddEventSecondary = document.getElementById("date-workspace-add-event-secondary");
  var eventModal = document.getElementById("event-modal");
  var cancelEvent = document.getElementById("cancel-event");
  var folderModal = document.getElementById("folder-modal");
  var cancelFolder = document.getElementById("cancel-folder");
  function closeFolderModal() {
    if (folderModal) folderModal.hidden = true;
  }
  if (newFolderButton && folderModal) {
    newFolderButton.addEventListener("click", function () {
      folderModal.hidden = false;
      if (newMenu) newMenu.hidden = true;
      var folderName = document.getElementById("folder-name");
      if (folderName) folderName.focus();
    });
    if (cancelFolder) cancelFolder.addEventListener("click", closeFolderModal);
    folderModal.addEventListener("click", function (event) {
      if (event.target === folderModal) closeFolderModal();
    });
  }
  function openEventModal() {
    if (!eventModal) return;
    eventModal.hidden = false;
    if (newMenu) newMenu.hidden = true;
    var eventName = document.getElementById("event-name");
    if (eventName) eventName.focus();
  }
  if (newEventButton && eventModal) {
    newEventButton.addEventListener("click", openEventModal);
    if (eventsHomeAddEvent) eventsHomeAddEvent.addEventListener("click", openEventModal);
    if (dateWorkspaceAddEvent) dateWorkspaceAddEvent.addEventListener("click", openEventModal);
    if (dateWorkspaceAddEventSecondary) dateWorkspaceAddEventSecondary.addEventListener("click", openEventModal);
    if (cancelEvent) cancelEvent.addEventListener("click", function () { eventModal.hidden = true; });
    eventModal.addEventListener("click", function (event) { if (event.target === eventModal) eventModal.hidden = true; });
  }

  var eventsCalendarButton = document.getElementById("events-calendar-button");
  var eventsCalendarModal = document.getElementById("events-calendar-modal");
  var eventsCalendarModalCard = eventsCalendarModal ? eventsCalendarModal.querySelector(".events-calendar-modal-card") : null;
  var closeEventsCalendar = document.getElementById("close-events-calendar");
  function syncCalendarModalState(isOpen) {
    var url = new URL(window.location.href);
    if (isOpen) {
      url.searchParams.set("calendar", "open");
    } else {
      url.searchParams.delete("calendar");
    }
    window.history.replaceState(null, "", url.toString());
  }
  function closeEventsCalendarModal() {
    if (!eventsCalendarModal) return;
    eventsCalendarModal.hidden = true;
    if (eventsCalendarButton) eventsCalendarButton.setAttribute("aria-expanded", "false");
    syncCalendarModalState(false);
  }
  function openEventsCalendarModal() {
    if (!eventsCalendarModal) return;
    eventsCalendarModal.hidden = false;
    if (eventsCalendarButton) eventsCalendarButton.setAttribute("aria-expanded", "true");
    syncCalendarModalState(true);
  }
  if (eventsCalendarButton && eventsCalendarModal) {
    eventsCalendarButton.addEventListener("click", openEventsCalendarModal);
    if (closeEventsCalendar) closeEventsCalendar.addEventListener("click", closeEventsCalendarModal);
    eventsCalendarModal.addEventListener("click", function (event) {
      if (event.target === eventsCalendarModal) closeEventsCalendarModal();
    });
    if (eventsCalendarModalCard && eventsCalendarModalCard.dataset.autoOpen === "true") openEventsCalendarModal();
  }

  var bulkForm = document.getElementById("bulk-form");
  var bulkToolbar = document.getElementById("bulk-toolbar");
  var workspaceTitle = document.querySelector(".workspace-title");
  var clearBulkSelection = document.getElementById("clear-bulk-selection");
  var bulkActionsButton = document.getElementById("bulk-actions-button");
  var bulkActionsModal = document.getElementById("bulk-actions-modal");
  var moveModal = document.getElementById("move-modal");
  var moveForm = document.getElementById("move-form");
  var cancelMove = document.getElementById("cancel-move");
  var moveDestination = document.getElementById("move-destination");
  function closeMoveModal() {
    if (moveModal) moveModal.hidden = true;
  }
  function openMoveModal(selections) {
    if (!moveModal || !moveDestination || !selections.length) return;
    var currentLocations = selections.map(function (input) {
      var row = input.closest(".workspace-item, tr");
      return row ? (row.dataset.parentId || "root") : "";
    });
    var selectedFolderIds = selections.filter(function (input) { return input.value.indexOf("folder:") === 0; }).map(function (input) {
      return input.value.split(":")[1];
    });
    Array.from(moveDestination.options).forEach(function (option) {
      option.hidden = currentLocations.includes(option.value) || selectedFolderIds.includes(option.value);
      option.disabled = option.hidden;
    });
    var availableDestination = Array.from(moveDestination.options).find(function (option) { return !option.hidden; });
    if (!availableDestination) return;
    moveDestination.value = availableDestination.value;
    moveModal.hidden = false;
    moveDestination.focus();
  }
  function closeBulkActions() {
    if (bulkActionsModal) bulkActionsModal.hidden = true;
    if (bulkActionsButton) bulkActionsButton.setAttribute("aria-expanded", "false");
  }
  function positionBulkActions() {
    if (!bulkActionsModal || bulkActionsModal.hidden || !bulkActionsButton) return;
    var card = bulkActionsModal.querySelector(".item-actions-card");
    if (!card) return;
    var buttonRect = bulkActionsButton.getBoundingClientRect();
    var gap = 8;
    var margin = 8;
    var left = buttonRect.right - card.offsetWidth;
    var top = buttonRect.bottom + gap;
    if (top + card.offsetHeight > window.innerHeight - margin) top = buttonRect.top - card.offsetHeight - gap;
    card.style.left = Math.max(margin, Math.min(left, window.innerWidth - card.offsetWidth - margin)) + "px";
    card.style.top = Math.max(margin, Math.min(top, window.innerHeight - card.offsetHeight - margin)) + "px";
  }
  function submitMove() {
    if (!bulkForm || !moveDestination) return;
    var destination = bulkForm.querySelector("input[name='destination_id']");
    if (destination) destination.remove();
    destination = document.createElement("input");
    destination.type = "hidden";
    destination.name = "destination_id";
    destination.value = moveDestination.value;
    bulkForm.appendChild(destination);
    bulkForm.action = "/items/move";
    addWorkspaceReturnTarget(bulkForm);
    bulkForm.submit();
  }
  if (cancelMove) cancelMove.addEventListener("click", closeMoveModal);
  if (moveModal) moveModal.addEventListener("click", function (event) {
    if (event.target === moveModal) closeMoveModal();
  });
  if (moveForm) moveForm.addEventListener("submit", function (event) {
    event.preventDefault();
    closeMoveModal();
    submitMove();
  });
  var selectedCount = document.getElementById("selected-count");
  var selectAll = document.getElementById("select-all");
  var itemSelections = Array.from(document.querySelectorAll(".item-select"));
  var mobileSelectButton = document.getElementById("mobile-select-button");
  var fileWorkspace = document.getElementById("file-results");
  var bulkStarAction = document.getElementById("bulk-star-action");
  var bulkOfflineAction = document.getElementById("bulk-offline-action");
  var bulkOfflineSyncId = 0;
  function refreshBulkSelectionElements() {
    selectAll = document.getElementById("select-all");
    itemSelections = Array.from(document.querySelectorAll(".item-select"));
    mobileSelectButton = document.getElementById("mobile-select-button");
    fileWorkspace = document.getElementById("file-results");
  }
  function setMobileSelectMode(enabled) {
    refreshBulkSelectionElements();
    if (!fileWorkspace || !mobileSelectButton) return;
    fileWorkspace.classList.toggle("mobile-select-mode", enabled);
    mobileSelectButton.setAttribute("aria-pressed", String(enabled));
    mobileSelectButton.innerHTML = enabled
      ? "Done"
      : '<i class="bi bi-check2-square" aria-hidden="true"></i> Select';
    if (!enabled) {
      itemSelections.forEach(function (input) { input.checked = false; });
      updateBulkToolbar();
    }
  }
  function selectedOfflineUrls() {
    return Array.from(new Set(itemSelections.filter(function (input) {
      return input.checked;
    }).map(function (input) {
      var itemElement = input.closest(".workspace-item, tr");
      var trigger = itemElement ? itemElement.querySelector(".more-actions-button[data-offline-url]") : null;
      return trigger ? trigger.dataset.offlineUrl : "";
    }).filter(Boolean)));
  }
  async function syncBulkOfflineAction() {
    if (!bulkOfflineAction || bulkOfflineAction.dataset.offlineLoading === "true") return;
    var syncId = ++bulkOfflineSyncId;
    var urls = selectedOfflineUrls();
    if (!urls.length) {
      renderOfflineAction(bulkOfflineAction, false);
      return;
    }
    var states = await Promise.all(urls.map(isAccessibleOffline));
    if (syncId !== bulkOfflineSyncId) return;
    renderOfflineAction(bulkOfflineAction, states.every(Boolean));
    var label = states.every(Boolean) ? "Unsave offline access from selected items" : "Make selected items accessible offline";
    bulkOfflineAction.setAttribute("aria-label", label);
    bulkOfflineAction.setAttribute("title", label);
  }
  function updateBulkToolbar() {
    var selected = itemSelections.filter(function (input) { return input.checked; });
    if (bulkToolbar) bulkToolbar.hidden = selected.length === 0;
    if (selected.length === 0) closeBulkActions();
    if (workspaceTitle) workspaceTitle.classList.toggle("bulk-selection-active", selected.length > 0);
    if (selectedCount) selectedCount.textContent = selected.length + " item" + (selected.length === 1 ? "" : "s") + " selected";
    if (selectAll) selectAll.checked = selected.length > 0 && selected.length === itemSelections.length;
    syncBulkOfflineAction();
    if (bulkStarAction) {
      var selectedStarStates = selected.map(function (input) {
        var itemElement = input.closest(".workspace-item, tr");
        var starToggle = itemElement ? itemElement.querySelector(".toggle-star") : null;
        return starToggle && starToggle.dataset.starred === "false";
      });
      var allStarred = selectedStarStates.length > 0 && selectedStarStates.every(Boolean);
      var allUnstarred = selectedStarStates.length > 0 && selectedStarStates.every(function (isStarred) { return !isStarred; });
      bulkStarAction.hidden = !allStarred && !allUnstarred;
      if (allStarred || allUnstarred) {
        bulkStarAction.dataset.starred = allUnstarred ? "true" : "false";
        bulkStarAction.innerHTML = allUnstarred ? '<i class="bi bi-star" aria-hidden="true"></i>' : '<i class="bi bi-star-fill" aria-hidden="true"></i>';
        bulkStarAction.setAttribute("aria-label", allUnstarred ? "Star selected items" : "Unstar selected items");
        bulkStarAction.setAttribute("title", allUnstarred ? "Star selected items" : "Unstar selected items");
      }
    }
  }
  document.addEventListener("change", function (event) {
    if (event.target.matches(".item-select")) {
      refreshBulkSelectionElements();
      updateBulkToolbar();
      return;
    }
    if (event.target.id !== "select-all") return;
    refreshBulkSelectionElements();
    itemSelections.forEach(function (input) { input.checked = event.target.checked; });
    updateBulkToolbar();
  });
  document.addEventListener("click", function (event) {
    var selectButton = event.target.closest("#mobile-select-button");
    if (!selectButton) return;
    setMobileSelectMode(selectButton.getAttribute("aria-pressed") !== "true");
  });
  document.addEventListener("click", function (event) {
    var row = event.target.closest(".file-workspace.mobile-select-mode .workspace-item, .file-workspace.mobile-select-mode .file-table tbody tr");
    if (!row || event.target.closest("button, input, label, select, textarea, .actions")) return;
    var selection = row.querySelector(".item-select");
    if (!selection) return;
    event.preventDefault();
    event.stopPropagation();
    selection.checked = !selection.checked;
    selection.dispatchEvent(new Event("change", { bubbles: true }));
  }, true);
  if (clearBulkSelection) clearBulkSelection.addEventListener("click", function () {
    setMobileSelectMode(false);
  });
  if (bulkOfflineAction) bulkOfflineAction.addEventListener("click", async function (event) {
    event.preventDefault();
    event.stopPropagation();
    var urls = selectedOfflineUrls();
    if (!urls.length) return;
    var removeAll = bulkOfflineAction.dataset.offlineCached === "true";
    setOfflineActionLoading(bulkOfflineAction, true, removeAll);
    try {
      var states = await Promise.all(urls.map(isAccessibleOffline));
      removeAll = states.every(Boolean);
      for (var index = 0; index < urls.length; index += 1) {
        if (removeAll) {
          await removeItemOffline(urls[index]);
        } else if (!states[index]) {
          await cacheItemOffline(urls[index]);
        }
      }
      setOfflineActionLoading(bulkOfflineAction, false, removeAll);
      await syncBulkOfflineAction();
      showToast(removeAll ? "Offline access removed from selected items." : "Selected items are available offline.", "success");
    } catch (error) {
      setOfflineActionLoading(bulkOfflineAction, false, removeAll);
      await syncBulkOfflineAction();
      showToast(error.message || "Offline access could not be updated.", "error");
    }
  });
  if (moveItemButton) moveItemButton.addEventListener("click", function () {
    var row = activeItemRow;
    if (!row) return;
    var selection = selectOnlyRow(row);
    if (!selection) return;
    closeItemActions();
    openMoveModal([selection]);
  });
  if (bulkActionsButton) bulkActionsButton.addEventListener("click", function (event) {
    event.stopPropagation();
    if (!bulkActionsModal) return;
    if (bulkActionsModal.hidden) {
      bulkActionsModal.hidden = false;
      bulkActionsButton.setAttribute("aria-expanded", "true");
      positionBulkActions();
    } else {
      closeBulkActions();
    }
  });
  if (bulkActionsModal) bulkActionsModal.addEventListener("click", function (event) {
    if (event.target === bulkActionsModal) closeBulkActions();
  });
  document.addEventListener("click", function (event) {
    if (!bulkActionsModal || bulkActionsModal.hidden) return;
    var card = bulkActionsModal.querySelector(".item-actions-card");
    if (card && !card.contains(event.target) && event.target !== bulkActionsButton) closeBulkActions();
  });
  window.addEventListener("resize", positionBulkActions);
  window.addEventListener("scroll", positionBulkActions, true);
  if (bulkForm) {
    function submitBulkAction(button) {
      bulkForm.action = button.dataset.action;
      addWorkspaceReturnTarget(bulkForm);
      var oldStarred = bulkForm.querySelector("input[name='starred']");
      if (oldStarred) oldStarred.remove();
      if (button.dataset.starred) {
        var starred = document.createElement("input");
        starred.type = "hidden";
        starred.name = "starred";
        starred.value = button.dataset.starred;
        bulkForm.appendChild(starred);
      }
      bulkForm.submit();
    }
    Array.from(document.querySelectorAll("#bulk-toolbar button[data-action], #bulk-actions-modal button[data-action]")).forEach(function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        if (!itemSelections.some(function (input) { return input.checked; })) return;
        if (button.dataset.action === "/items/move") {
          closeBulkActions();
          openMoveModal(itemSelections.filter(function (input) { return input.checked; }));
          return;
        }
        if (button.dataset.action === "/items/trash") {
          showCustomConfirm("Move the selected items to Trash?", "Move to Trash", true, function () { submitBulkAction(button); });
          return;
        }
        if (button.dataset.action === "/items/permanent-delete") {
          showCustomConfirm("Permanently delete the selected items? This cannot be undone.", "Delete permanently", true, function () { submitBulkAction(button); });
          return;
        }
        submitBulkAction(button);
      });
    });
    document.addEventListener("click", function (event) {
      var button = event.target.closest(".toggle-star");
      if (!button || !bulkForm.contains(button)) return;
      event.preventDefault();
      refreshBulkSelectionElements();
      var selection = itemSelections.find(function (input) { return input.value === button.dataset.item; });
      submitStarUpdate(selection, button);
    });
  }

  var textPreview = document.getElementById("text-preview");
  if (textPreview) {
    fetch(textPreview.dataset.contentUrl).then(function (response) {
      if (!response.ok) throw new Error("Preview request failed");
      return response.text();
    }).then(function (content) {
      textPreview.textContent = content;
    }).catch(function () {
      textPreview.textContent = "Text preview could not be loaded. Download the file to view it.";
    });
  }

  var copyLink = document.getElementById("copy-link");
  if (copyLink) {
    copyLink.addEventListener("click", function () {
      navigator.clipboard.writeText(copyLink.dataset.copyUrl).then(function () {
        showToast("Link copied.", "success");
      }).catch(function () {
        showToast("Copy failed. Please try again.", "error");
      });
    });
  }

  var powerpointPreview = document.getElementById("powerpoint-preview");
  if (powerpointPreview) {
    var powerpointStatus = document.getElementById("powerpoint-status");
    var previousSlide = document.getElementById("powerpoint-previous");
    var nextSlide = document.getElementById("powerpoint-next");
    var powerpointCanvas = document.getElementById("powerpoint-canvas");
    var extension = powerpointPreview.dataset.extension;
    function powerpointUnavailable(message) {
      powerpointPreview.classList.add("powerpoint-unavailable");
      powerpointCanvas.hidden = true;
      previousSlide.hidden = true;
      nextSlide.hidden = true;
      powerpointStatus.textContent = message + " Download the original file to view it.";
    }
    if (extension !== "pptx") {
      powerpointUnavailable("Preview unavailable for legacy .ppt files in this browser.");
    } else if (!window.PptxViewJS) {
      powerpointUnavailable("PowerPoint viewer could not be loaded.");
    } else {
      fetch(powerpointPreview.dataset.contentUrl).then(function (response) {
        if (!response.ok) throw new Error("PowerPoint request failed");
        return response.blob();
      }).then(async function (blob) {
        var file = new File([blob], "presentation.pptx", { type: blob.type });
        var viewer = new window.PptxViewJS.PPTXViewer({ canvas: powerpointCanvas });
        await viewer.loadFile(file);
        await viewer.render();
        function updateSlideControls() {
          var current = viewer.getCurrentSlideIndex() + 1;
          var total = viewer.getSlideCount();
          powerpointStatus.textContent = "Slide " + current + " of " + total;
          previousSlide.disabled = current <= 1;
          nextSlide.disabled = current >= total;
        }
        previousSlide.addEventListener("click", async function () { await viewer.previousSlide(); updateSlideControls(); });
        nextSlide.addEventListener("click", async function () { await viewer.nextSlide(); updateSlideControls(); });
        updateSlideControls();
      }).catch(function () {
        powerpointUnavailable("PowerPoint preview could not be rendered.");
      });
    }
  }
});
