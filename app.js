import { initializeApp, getApps } from
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";

import {
  getAuth, signInWithEmailAndPassword, signInWithCustomToken,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import {
  getFunctions, httpsCallable
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

import { firebaseConfig } from "./firebase-config.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const functions = getFunctions(app, "asia-southeast1");

const call = name => httpsCallable(functions, name);
const loginWithQr = call("loginWithQr");
const loginWithIdPin = call("loginWithIdPin");
const createUserAccount = call("createUserAccount");
const getMyAccount = call("getMyAccount");

const $ = id => document.getElementById(id);

const defaults = {
  green: "#009900",
  yellow: "#f9dc07",
  orange: "#ff9900",
  white: "#ffffff",
  dark: "#003300",
  gray: "#4d4d4d",
  page: "#f3f8f2"
};

const colorIds = {
  green: "colorGreen",
  yellow: "colorYellow",
  orange: "colorOrange",
  white: "colorWhite",
  dark: "colorDark",
  gray: "colorGray",
  page: "colorPage"
};

let currentAccount = null;
let cameraStream = null;
let scanTimer = null;
let generatedQr = "";
let adminSignedIn = false;

function status(id, message) {
  $(id).textContent = message;
}

function friendlyError(error) {
  const code = error?.code || "";
  if (code.includes("already-exists")) return "That ID or username is already registered.";
  if (code.includes("permission-denied")) return "Admin permission is required for that action.";
  if (code.includes("unauthenticated")) return "The credentials are invalid or the session has expired.";
  return error?.message || "Something went wrong. Please try again.";
}

/* ---------- Theme customization ---------- */

function applyTheme(theme) {
  const root = document.documentElement;
  const variables = {
    green: "--green",
    yellow: "--yellow",
    orange: "--orange",
    white: "--panel",
    dark: "--dark",
    gray: "--gray",
    page: "--page"
  };

  for (const [key, variable] of Object.entries(variables)) {
    root.style.setProperty(variable, theme[key] || defaults[key]);
  }

  // White remains the main white color; panel color is customized with it.
  root.style.setProperty("--white", theme.white || defaults.white);

  for (const [key, id] of Object.entries(colorIds)) {
    $(id).value = theme[key] || defaults[key];
  }
}

function readThemeInputs() {
  return Object.fromEntries(
    Object.entries(colorIds).map(([key, id]) => [key, $(id).value])
  );
}

function loadTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem("ecosort-theme") || "null");
    applyTheme({ ...defaults, ...(saved || {}) });
  } catch {
    applyTheme(defaults);
  }
}

$("themeOpen").addEventListener("click", () => {
  $("themePanel").classList.toggle("hidden");
});

$("closeTheme").addEventListener("click", () => {
  $("themePanel").classList.add("hidden");
});

$("saveTheme").addEventListener("click", () => {
  const theme = readThemeInputs();
  localStorage.setItem("ecosort-theme", JSON.stringify(theme));
  applyTheme(theme);
  status("themeStatus", "Your theme has been saved on this device.");
});

$("resetTheme").addEventListener("click", () => {
  localStorage.removeItem("ecosort-theme");
  applyTheme(defaults);
  status("themeStatus", "Default EcoSort colors restored.");
});

loadTheme();

/* ---------- Account display ---------- */

async function refreshAccount() {
  if (!auth.currentUser) {
    currentAccount = null;
    $("loginPanel").classList.remove("hidden");
    $("appPanel").classList.add("hidden");
    return;
  }

  try {
    const result = await getMyAccount();
    currentAccount = result.data;

    $("loginPanel").classList.add("hidden");
    $("appPanel").classList.remove("hidden");
    $("accountInfo").textContent =
      `${currentAccount.fullName} · ID: ${currentAccount.idNumber}` +
      (currentAccount.username ? ` · @${currentAccount.username}` : "");

    renderActivity();
  } catch (error) {
    status("loginStatus", friendlyError(error));
    await signOut(auth);
  }
}

onAuthStateChanged(auth, async () => {
  await refreshAccount();
});

/* ---------- QR camera scanner ---------- */

function stopScanner() {
  if (scanTimer) cancelAnimationFrame(scanTimer);
  scanTimer = null;

  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
  }

  cameraStream = null;
  $("qrVideo").srcObject = null;
  $("qrVideo").classList.add("hidden");
}

async function beginScanner() {
  stopScanner();

  if (!navigator.mediaDevices?.getUserMedia) {
    status("loginStatus", "Camera scanning requires HTTPS and a supported browser.");
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });

    const video = $("qrVideo");
    video.srcObject = cameraStream;
    video.classList.remove("hidden");
    await video.play();

    const canvas = $("qrCanvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const scanFrame = () => {
      if (!cameraStream || video.readyState < 2) {
        scanTimer = requestAnimationFrame(scanFrame);
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(
        pixels.data, pixels.width, pixels.height,
        { inversionAttempts: "attemptBoth" }
      );

      if (code?.data) {
        stopScanner();
        authenticateQrPayload(code.data);
        return;
      }

      scanTimer = requestAnimationFrame(scanFrame);
    };

    scanFrame();
    status("loginStatus", "Point the camera at your EcoSort user QR.");
  } catch (error) {
    stopScanner();
    status("loginStatus", "Could not open camera. Check browser permissions or upload the QR image instead.");
  }
}

$("scanLogin").addEventListener("click", beginScanner);

/* ---------- QR image upload ---------- */

$("uploadLogin").addEventListener("click", () => $("qrFile").click());

$("qrFile").addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    status("loginStatus", "Please select an image file.");
    return;
  }

  const image = new Image();
  const reader = new FileReader();

  reader.onload = () => {
    image.onload = () => {
      const canvas = $("qrCanvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);

      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(
        pixels.data, pixels.width, pixels.height,
        { inversionAttempts: "attemptBoth" }
      );

      if (!code?.data) {
        status("loginStatus", "No readable QR code found. Try a clearer image.");
        return;
      }

      authenticateQrPayload(code.data);
    };

    image.onerror = () => status("loginStatus", "Could not read that image.");
    image.src = reader.result;
  };

  reader.readAsDataURL(file);
  event.target.value = "";
});

async function authenticateQrPayload(payload) {
  try {
    status("loginStatus", "Verifying QR credential…");
    const result = await loginWithQr({ payload });
    await signInWithCustomToken(auth, result.data.customToken);
    status("loginStatus", "Login successful.");
  } catch (error) {
    status("loginStatus", friendlyError(error));
  }
}

/* ---------- Manual ID + PIN login ---------- */

$("manualLogin").addEventListener("click", async () => {
  const idNumber = $("loginId").value.trim();
  const pin = $("loginPin").value.trim();

  if (!idNumber || !/^\d{6}$/.test(pin)) {
    status("loginStatus", "Enter your ID number and six-digit PIN.");
    return;
  }

  try {
    status("loginStatus", "Checking credentials…");
    const result = await loginWithIdPin({ idNumber, pin });
    await signInWithCustomToken(auth, result.data.customToken);
    $("loginPin").value = "";
    status("loginStatus", "Login successful.");
  } catch (error) {
    status("loginStatus", friendlyError(error));
  }
});

/* ---------- Administrator sign-in and account creation ---------- */

$("adminLogin").addEventListener("click", async () => {
  const email = $("adminEmail").value.trim();
  const password = $("adminPassword").value;

  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const token = await credential.user.getIdTokenResult(true);

    if (token.claims.admin !== true) {
      await signOut(auth);
      throw new Error("This Firebase account does not have administrator privileges.");
    }

    adminSignedIn = true;
    $("createAccountPanel").classList.remove("hidden");
    status("adminStatus", "Administrator verified.");
  } catch (error) {
    status("adminStatus", friendlyError(error));
  }
});

$("createAccount").addEventListener("click", async () => {
  if (!adminSignedIn || auth.currentUser === null) {
    status("newCredentials", "Sign in as an administrator first.");
    return;
  }

  const fullName = $("newFullName").value.trim();
  const idNumber = $("newId").value.trim();
  const username = $("newUsername").value.trim();

  if (!fullName || !idNumber) {
    status("newCredentials", "Full name and ID number are required.");
    return;
  }

  try {
    const result = await createUserAccount({ fullName, idNumber, username });
    generatedQr = result.data.qrPayload;

    $("qrOutput").replaceChildren();
    await QRCode.toCanvas(generatedQr, { width: 240, margin: 2 })
      .then(canvas => $("qrOutput").appendChild(canvas));

    status(
      "newCredentials",
      `Account created for ${result.data.fullName}.\n` +
      `Initial PIN: ${result.data.pin}\n` +
      "Give the PIN and QR securely to the account holder. Do not post them publicly."
    );
  } catch (error) {
    status("newCredentials", friendlyError(error));
  }
});

$("downloadQr").addEventListener("click", async () => {
  if (!generatedQr) {
    status("newCredentials", "Create an account first.");
    return;
  }

  try {
    const url = await QRCode.toDataURL(generatedQr, {
      width: 600,
      margin: 3
    });

    const a = document.createElement("a");
    a.href = url;
    a.download = "ecosort-user-qr.png";
    a.click();
  } catch {
    status("newCredentials", "QR download failed.");
  }
});

/* ---------- Disposal activity ---------- */

const CATEGORY_MAP = {
  "banana peel": "Biodegradable",
  "food scraps": "Biodegradable",
  "dry leaves": "Biodegradable",
  "paper": "Recyclable",
  "cardboard": "Recyclable",
  "plastic bottle": "Recyclable",
  "aluminum can": "Recyclable",
  "glass bottle": "Recyclable",
  "plastic wrapper": "Residual",
  "foam container": "Residual",
  "battery": "Hazardous",
  "other / unlisted item": "Residual"
};

function activityKey() {
  return `ecosort-activity-${auth.currentUser?.uid || "guest"}`;
}

function getActivity() {
  try {
    return JSON.parse(localStorage.getItem(activityKey()) || "[]");
  } catch {
    return [];
  }
}

function renderActivity() {
  const records = getActivity();
  const list = $("activityList");
  list.replaceChildren();

  for (const record of records.slice().reverse()) {
    const li = document.createElement("li");
    li.textContent =
      `${record.item} → ${record.bin} · ${record.points} points`;
    list.appendChild(li);
  }

  $("pointsTotal").textContent =
    `Eco-points: ${records.reduce((sum, r) => sum + r.points, 0)}`;
}

$("recordDisposal").addEventListener("click", () => {
  if (!auth.currentUser || !currentAccount) {
    status("disposalStatus", "Log in before recording a disposal.");
    return;
  }

  const item = $("wasteItem").value;
  const bin = $("wasteBin").value;
  const correct = CATEGORY_MAP[item] === bin;
  const records = getActivity();

  records.push({
    item,
    bin,
    correct,
    points: correct ? 10 : 0,
    timestamp: new Date().toISOString()
  });

  localStorage.setItem(activityKey(), JSON.stringify(records));
  renderActivity();

  status(
    "disposalStatus",
    correct
      ? "Correct category match. 10 eco-points earned."
      : "No points awarded. Review the item's correct category."
  );
});

$("logout").addEventListener("click", async () => {
  stopScanner();
  adminSignedIn = false;
  $("createAccountPanel").classList.add("hidden");
  await signOut(auth);
});
